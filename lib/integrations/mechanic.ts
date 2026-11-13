// The Mechanic: a repair agent on a different engine.
//
// The Codex worker cannot diagnose its own substrate failures — when its
// config is rejected it dies before any model loads. Diagnosis therefore
// runs on the knowledge service's LLM (Llama on the RAG host), through
// the same background-job pattern as Ask CompanyOS. This module gathers
// the worker-health evidence, runs the diagnosis job, validates the
// result against the same repair allowlist the worker enforces, and —
// when the diagnosis recommends an allowlisted runtime repair — records
// it as an owner approval for the DevOps agent (action_type
// "repair_worker"). Nothing executes without the owner's approval, and
// code faults are reported as "code_fix": they still ship through a pull
// request and the owner's merge.
//
// Server-side only: the service token must never reach the browser, and
// it is never logged.
import type { PoolClient } from "pg";
import { query } from "@/lib/db";
import { ragConfigured } from "@/lib/integrations/rag";

export type MechanicRepairAction = "restart_worker" | "update_worker" | "rollback_worker";
export type MechanicRecommendedAction = MechanicRepairAction | "code_fix" | "none";

export interface MechanicDiagnosis {
  summary: string;
  likely_cause: string;
  recommended_action: MechanicRecommendedAction;
  commit: string | null;
  rationale: string;
}

export type MechanicJobStatus =
  | { status: "queued" | "running" }
  | { status: "done"; diagnosis: MechanicDiagnosis }
  | { status: "error"; error: string };

const JOB_REQUEST_TIMEOUT_MS = 30_000;
const REPAIR_ACTIONS = new Set<string>(["restart_worker", "update_worker", "rollback_worker"]);
const RECOMMENDED_ACTIONS = new Set<string>([...REPAIR_ACTIONS, "code_fix", "none"]);
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

export { ragConfigured as mechanicConfigured };

function mechanicBaseAndToken(): { base: string; token: string } {
  const base = (process.env.RAG_API_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.RAG_SERVICE_TOKEN ?? "").trim();
  if (!base || !token) throw new Error("Mechanic service is not configured.");
  return { base, token };
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

// The diagnosis crosses a trust boundary (it is model output), so it is
// re-validated here exactly as the RAG service validated it: unknown
// actions degrade to "none", and a rollback without a well-formed commit
// is not actionable.
export function validateDiagnosis(raw: unknown): MechanicDiagnosis {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let action = typeof value.recommended_action === "string" && RECOMMENDED_ACTIONS.has(value.recommended_action)
    ? (value.recommended_action as MechanicRecommendedAction)
    : "none";
  const commitRaw = typeof value.commit === "string" ? value.commit.trim().toLowerCase() : "";
  const commit = COMMIT_PATTERN.test(commitRaw) ? commitRaw : null;
  if (action === "rollback_worker" && !commit) action = "none";
  return {
    summary: boundedText(value.summary, 600) || "The mechanic produced no summary.",
    likely_cause: boundedText(value.likely_cause, 400) || "unknown",
    recommended_action: action,
    commit,
    rationale: boundedText(value.rationale, 400) || "The mechanic gave no rationale; review the evidence before acting.",
  };
}

export function mechanicRepairLabel(action: MechanicRepairAction, commit?: string | null): string {
  switch (action) {
    case "restart_worker": return "Restart the Codex worker";
    case "update_worker": return "Update the Codex worker to the latest main";
    case "rollback_worker": return `Roll the Codex worker back to ${commit ?? "a previous commit"}`;
  }
}

export async function gatherWorkerHealthEvidence(): Promise<Record<string, unknown>> {
  const heartbeat = await query<{
    instance_id: string;
    status: string;
    details: Record<string, unknown> | null;
    last_seen_at: Date | string;
  }>(
    "SELECT instance_id,status,details,last_seen_at FROM runtime_heartbeats WHERE service_name='agent-worker' ORDER BY last_seen_at DESC LIMIT 1",
  );
  const failedRuns = await query<{ task_title: string | null; error: string | null; completed_at: Date | string | null }>(
    `SELECT t.title AS task_title, r.error, r.completed_at
     FROM agent_runs r LEFT JOIN tasks t ON t.id=r.task_id
     WHERE r.status='failed' ORDER BY r.created_at DESC LIMIT 6`,
  );
  const counts = await query<{ status: string; n: number }>(
    "SELECT status, COUNT(*)::int AS n FROM agent_runs WHERE status IN ('queued','running') GROUP BY status",
  );
  const row = heartbeat.rows[0];
  const lastSeen = row ? new Date(row.last_seen_at).getTime() : null;
  return {
    heartbeat: row
      ? {
          status: row.status,
          instance_id: row.instance_id,
          seconds_since_seen: lastSeen ? Math.max(0, Math.round((Date.now() - lastSeen) / 1000)) : null,
          details: row.details ?? {},
        }
      : null,
    recent_failed_runs: failedRuns.rows.map((run) => ({
      task_title: run.task_title ?? "(untitled task)",
      error: (run.error ?? "").slice(0, 300),
      failed_at: run.completed_at ? new Date(run.completed_at).toISOString() : null,
    })),
    queued_runs: counts.rows.find((c) => c.status === "queued")?.n ?? 0,
    running_runs: counts.rows.find((c) => c.status === "running")?.n ?? 0,
  };
}

export async function startMechanicDiagnosisJob(evidence: Record<string, unknown>): Promise<string> {
  const { base, token } = mechanicBaseAndToken();
  const response = await fetch(`${base}/diagnose/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ evidence }),
    cache: "no-store",
    signal: AbortSignal.timeout(JOB_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Mechanic service answered ${response.status}.`);
  const data = (await response.json()) as { job_id?: unknown };
  if (typeof data.job_id !== "string" || !data.job_id) {
    throw new Error("Mechanic service did not return a job id.");
  }
  return data.job_id;
}

export async function getMechanicDiagnosisJob(jobId: string): Promise<MechanicJobStatus> {
  const { base, token } = mechanicBaseAndToken();
  const response = await fetch(`${base}/diagnose/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(JOB_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return { status: "error", error: "That diagnosis expired before it finished — run it again." };
  }
  if (!response.ok) throw new Error(`Mechanic service answered ${response.status}.`);
  const data = (await response.json()) as { status?: unknown; diagnosis?: unknown };
  if (data.status === "done") {
    return { status: "done", diagnosis: validateDiagnosis(data.diagnosis) };
  }
  if (data.status === "error") {
    return { status: "error", error: "The mechanic could not complete the diagnosis." };
  }
  return { status: data.status === "running" ? "running" : "queued" };
}

// Records the diagnosis's recommended repair as a pending owner approval
// for the DevOps agent, and returns the approval id. Returns null when the
// diagnosis recommends no runtime repair (healthy, or a code fault that
// must ship through a pull request). Idempotent per diagnosis job: repeat
// polls return the approval created by the first one.
export async function createMechanicRepairApproval(
  client: PoolClient,
  jobId: string,
  diagnosis: MechanicDiagnosis,
): Promise<string | null> {
  if (!REPAIR_ACTIONS.has(diagnosis.recommended_action)) return null;
  const action = diagnosis.recommended_action as MechanicRepairAction;

  const existing = await client.query<{ id: string }>(
    "SELECT id FROM approvals WHERE action_type='repair_worker' AND payload->>'diagnosis_job_id'=$1 ORDER BY created_at LIMIT 1",
    [jobId],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const devops = await client.query<{ id: string }>(
    "SELECT id FROM agents WHERE LOWER(name)='devops' LIMIT 1",
  );
  const devopsId = devops.rows[0]?.id;
  if (!devopsId) return null;

  const label = mechanicRepairLabel(action, diagnosis.commit);
  const reason = [
    `Mechanic diagnosis: ${diagnosis.summary}`,
    `Likely cause: ${diagnosis.likely_cause}.`,
    diagnosis.rationale,
  ].join(" ").slice(0, 1000);
  const payload = {
    action,
    commit: action === "rollback_worker" ? diagnosis.commit : null,
    diagnosis_job_id: jobId,
  };
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO approvals (project_id,requested_by,action,risk_level,reason,agent_run_id,agent_id,action_type,proposal_index,payload)
     VALUES (NULL,'Mechanic',$1,'high',$2,NULL,$3,'repair_worker',NULL,$4::jsonb) RETURNING id`,
    [label, reason, devopsId, JSON.stringify(payload)],
  );
  const approvalId = inserted.rows[0]?.id ?? null;
  if (approvalId) {
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,payload)
       VALUES ('mechanic','repair_proposed',$1,'warning',$2::jsonb)`,
      [`Mechanic proposed a worker repair: ${label}`, JSON.stringify({ approval_id: approvalId, diagnosis_job_id: jobId, action })],
    );
  }
  return approvalId;
}
