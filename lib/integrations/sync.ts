import { query } from "../db";
import { syncCalendar, syncGmail } from "./google";
import { fetchJson } from "./http";
import { upsertExternalRecord } from "./records";

type SyncResult = { seen: number; written: number };

async function beginRun(name: string) {
  const result = await query<{ id: string }>("INSERT INTO sync_runs (integration_name,status) VALUES ($1,'running') RETURNING id", [name]);
  await query("UPDATE integration_connections SET status='syncing',updated_at=NOW(),last_error=NULL WHERE name=$1", [name]);
  return result.rows[0].id;
}

async function finishRun(name: string, runId: string, result: SyncResult) {
  await query("UPDATE sync_runs SET status='completed',records_seen=$2,records_written=$3,completed_at=NOW() WHERE id=$1", [runId, result.seen, result.written]);
  await query("UPDATE integration_connections SET status='healthy',last_sync_at=NOW(),last_error=NULL,updated_at=NOW() WHERE name=$1", [name]);
}

async function failRun(name: string, runId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await query("UPDATE sync_runs SET status='failed',error=$2,completed_at=NOW() WHERE id=$1", [runId, message.slice(0, 1000)]);
  await query("UPDATE integration_connections SET status='error',last_error=$2,updated_at=NOW() WHERE name=$1", [name, message.slice(0, 1000)]);
}

export async function runTrackedSync(name: string, action: () => Promise<SyncResult>) {
  const runId = await beginRun(name);
  try {
    const result = await action();
    await finishRun(name, runId, result);
    return { name, ...result };
  } catch (error) {
    await failRun(name, runId, error);
    throw error;
  }
}

async function syncGitHub(): Promise<SyncResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured.");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const me = await fetchJson<{ login: string }>("https://api.github.com/user", { headers });
  const repos = await fetchJson<Array<{ id: number; full_name: string; name: string; html_url: string; private: boolean; default_branch: string; updated_at: string; open_issues_count: number }>>("https://api.github.com/user/repos?per_page=100&sort=updated", { headers });
  let written = 0;
  for (const repo of repos) {
    written += await upsertExternalRecord({
      provider: "github",
      record_type: "repository",
      external_id: String(repo.id),
      title: repo.full_name,
      url: repo.html_url,
      status: repo.private ? "private" : "public",
      owner: me.login,
      occurred_at: repo.updated_at,
      payload: repo,
    });
  }

  const selectedRepo = process.env.GITHUB_REPO;
  if (selectedRepo) {
    const owner = process.env.GITHUB_OWNER ?? me.login;
    const [issues, pulls] = await Promise.all([
      fetchJson<Array<{ id: number; number: number; title: string; html_url: string; state: string; user?: { login?: string }; updated_at: string; pull_request?: unknown }>>(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(selectedRepo)}/issues?state=open&per_page=50`, { headers }),
      fetchJson<Array<{ id: number; number: number; title: string; html_url: string; state: string; user?: { login?: string }; updated_at: string }>>(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(selectedRepo)}/pulls?state=open&per_page=50`, { headers }),
    ]);
    for (const item of issues.filter((item) => !item.pull_request)) {
      written += await upsertExternalRecord({ provider: "github", record_type: "issue", external_id: String(item.id), title: item.title, url: item.html_url, status: item.state, owner: item.user?.login ?? null, occurred_at: item.updated_at, payload: item });
    }
    for (const item of pulls) {
      written += await upsertExternalRecord({ provider: "github", record_type: "pull_request", external_id: String(item.id), title: item.title, url: item.html_url, status: item.state, owner: item.user?.login ?? null, occurred_at: item.updated_at, payload: item });
    }
  }
  return { seen: repos.length + (selectedRepo ? 0 : 0), written };
}

async function syncNextcloud(): Promise<SyncResult> {
  const base = (process.env.NEXTCLOUD_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("NEXTCLOUD_URL is not configured.");
  const started = Date.now();
  const status = await fetchJson<{ installed?: boolean; maintenance?: boolean; version?: string; productname?: string }>(`${base}/status.php`);
  const latency = Date.now() - started;
  const project = await query<{ id: string }>("SELECT id FROM projects WHERE slug='sky-mountain-cloud' LIMIT 1");
  await query(`INSERT INTO system_checks (project_id,system_name,status,latency_ms,details)
    VALUES ($1,'Nextcloud',$2,$3,$4)`, [project.rows[0]?.id ?? null, status.maintenance ? "warning" : status.installed === false ? "error" : "healthy", latency, `${status.productname ?? "Nextcloud"} ${status.version ?? "unknown"}`]);
  const severity = status.maintenance ? "warning" : status.installed === false ? "critical" : "info";
  await query(`INSERT INTO events (project_id,source,event_type,title,severity,payload)
    VALUES ($1,'nextcloud','health_check',$2,$3,$4::jsonb)`, [project.rows[0]?.id ?? null, `Nextcloud health check: ${status.version ?? "unknown"}`, severity, JSON.stringify({ ...status, latency_ms: latency })]);
  return { seen: 1, written: 1 };
}

async function proxmoxRequest<T>(path: string): Promise<T> {
  const base = (process.env.PVE_API_URL ?? "").replace(/\/$/, "");
  const tokenId = process.env.PVE_TOKEN_ID;
  const tokenSecret = process.env.PVE_TOKEN_SECRET;
  if (!base || !tokenId || !tokenSecret) throw new Error("PVE_API_URL, PVE_TOKEN_ID and PVE_TOKEN_SECRET are required.");
  const response = await fetchJson<{ data: T }>(`${base}/api2/json${path}`, {
    headers: { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` },
  });
  return response.data;
}

async function syncProxmox(): Promise<SyncResult> {
  const nodes = await proxmoxRequest<Array<{ node: string; status: string }>>("/nodes");
  let written = 0;
  const cloudProject = await query<{ id: string }>("SELECT id FROM projects WHERE slug='sky-mountain-cloud' LIMIT 1");
  for (const node of nodes) {
    const started = Date.now();
    let status = node.status;
    let details = `Proxmox node ${node.node}`;
    try {
      const nodeStatus = await proxmoxRequest<{ uptime?: number; cpu?: number; memory?: { used?: number; total?: number }; rootfs?: { used?: number; total?: number } }>(`/nodes/${encodeURIComponent(node.node)}/status`);
      details = `${node.node}: CPU ${Math.round((nodeStatus.cpu ?? 0) * 100)}%, memory ${nodeStatus.memory?.used ? Math.round(nodeStatus.memory.used / (nodeStatus.memory.total || 1) * 100) : 0}%`;
      status = "healthy";
    } catch (error) {
      status = "error";
      details = error instanceof Error ? error.message : String(error);
    }
    await query(`INSERT INTO system_checks (project_id,system_name,status,latency_ms,details)
      VALUES ($1,$2,$3,$4,$5)`, [cloudProject.rows[0]?.id ?? null, `Proxmox:${node.node}`, status === "online" || status === "healthy" ? "healthy" : "error", Date.now() - started, details]);
    written += 1;
  }
  return { seen: nodes.length, written };
}

export async function isIntegrationConfigured(name: string) {
  if (name === "Gmail" || name === "Google Calendar") {
    try {
      const result = await query<{ id: string }>("SELECT id FROM integration_secrets WHERE name='google-oauth' LIMIT 1");
      return Boolean(result.rowCount);
    } catch {
      return false;
    }
  }
  if (name === "GitHub") return Boolean(process.env.GITHUB_TOKEN);
  if (name === "Proxmox") return Boolean(process.env.PVE_API_URL && process.env.PVE_TOKEN_ID && process.env.PVE_TOKEN_SECRET);
  if (name === "Nextcloud") return Boolean(process.env.NEXTCLOUD_URL);
  return false;
}

export async function syncIntegration(name: string) {
  if (name === "Gmail") return runTrackedSync("Gmail", syncGmail);
  if (name === "Google Calendar") return runTrackedSync("Google Calendar", syncCalendar);
  if (name === "GitHub") return runTrackedSync("GitHub", syncGitHub);
  if (name === "Proxmox") return runTrackedSync("Proxmox", syncProxmox);
  if (name === "Nextcloud") return runTrackedSync("Nextcloud", syncNextcloud);
  throw new Error(`No collector is implemented for ${name}.`);
}
