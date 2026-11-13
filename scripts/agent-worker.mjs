import { readFile, readdir, stat, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";

const { Pool } = pg;

// Read .env.local if present
const envFile = await readFile(resolve(process.cwd(), ".env.local"), "utf8").catch(() => "");
for (const line of envFile.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!match || process.env[match[1]] !== undefined) continue;
  const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
  process.env[match[1]] = value;
}

const interval = Math.min(60_000, Math.max(1_000, Number(process.env.COMPANYOS_AGENT_WORKER_INTERVAL_MS) || 3_000));

// Worker mode is explicit opt-in. Direct database mode runs only when
// COMPANYOS_WORKER_MODE=db AND DATABASE_URL is present; DATABASE_URL alone
// must never select it, because DB mode bypasses the HTTP worker route and
// its ancillary jobs (outbound email, sales follow-ups, handoff expiry).
// Anything else — including "db" without DATABASE_URL — uses HTTP polling.
const requestedWorkerMode = (process.env.COMPANYOS_WORKER_MODE || "").trim().toLowerCase();
if (requestedWorkerMode === "db" && !process.env.DATABASE_URL) {
  console.error("COMPANYOS_WORKER_MODE=db requires DATABASE_URL; falling back to HTTP polling mode.");
}
const useDatabaseMode = requestedWorkerMode === "db" && Boolean(process.env.DATABASE_URL);

// Mirror of boundedText in lib/ai/tool-registry.ts: strips control
// characters, trims, and slices to the limit.
function boundedText(value, limit) {
  if (typeof value !== "string") return "";
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").trim().slice(0, limit);
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

// Check Codex CLI status
async function checkCodexStatus() {
  return new Promise((resolveStatus) => {
    try {
      const child = spawn("codex", ["login", "status"], { windowsHide: true, stdio: "ignore" });
      child.on("error", () => resolveStatus({ installed: false, authenticated: false }));
      child.on("close", (code) => resolveStatus({ installed: true, authenticated: code === 0 }));
    } catch {
      resolveStatus({ installed: false, authenticated: false });
    }
  });
}

// Codex isolation arguments. These MUST stay in parity with the server-side
// runner in lib/ai/router.ts (runWithCodexCli): the worker executes the same
// untrusted task prompts, so it gets the same boundary — no user config, no
// approvals, an isolated permission profile with the filesystem denied by
// default, no network, and no inherited shell environment for model tools.
// tests/worker-codex-isolation.test.ts asserts this parity; update both
// places together.
const CODEX_ISOLATION_CONFIG_ARGS = [
  "-c", 'approval_policy="never"',
  "-c", 'default_permissions="companyos_isolated"',
  // The filesystem table MUST be one inline-table override: Codex's -c
  // parser rejects dotted keys with quoted special-path segments (":root")
  // — the merged config fails to load with "data did not match any variant
  // of untagged enum FilesystemPermissionToml". Verified live against
  // codex-cli 0.166.0 / 0.167.2 (doctor): dotted form rejected, inline
  // table and config-file forms accepted.
  "-c", 'permissions.companyos_isolated.filesystem={ ":root" = "deny", ":minimal" = "read", ":workspace_roots" = { "." = "read" } }',
  "-c", "permissions.companyos_isolated.network.enabled=false",
  "-c", 'shell_environment_policy.inherit="none"',
];

// --- Worker self-check ---------------------------------------------------
// Substrate drift — a Codex config the CLI rejects, a missing database
// column, a missing API key — otherwise surfaces as a mysteriously failed
// first task (run 5fd29a5b, 2026-11-12: Codex exited at config load before
// any agent started). The worker therefore test-loads its own launch
// configuration and reports the result in its heartbeat: once at startup,
// every SELF_CHECK_INTERVAL_MS, and immediately after any run dies with a
// config-load signature (the circuit breaker: codexConfigSuspect forces a
// re-check, and the DB claim loop refuses to claim while the last check
// failed, so one broken substrate fails ONE alarm, not every task).
const CODEX_CONFIG_ERROR_SIGNATURE = /Error loading config\.toml|did not match any variant of untagged enum|config could not be loaded/i;
let codexConfigSuspect = false;

function runWorkerCommand(command, args, timeoutMs) {
  return new Promise((resolveCommand) => {
    let output = "";
    let settled = false;
    const done = (code) => {
      if (!settled) {
        settled = true;
        resolveCommand({ code, output });
      }
    };
    try {
      const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill();
        done(null);
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (output.length < 20_000) output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (output.length < 20_000) output += chunk;
      });
      child.on("error", () => {
        clearTimeout(timer);
        done(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code);
      });
    } catch {
      done(null);
    }
  });
}

async function runWorkerSelfCheck(dbClient) {
  const versionResult = await runWorkerCommand("codex", ["--version"], 10_000);
  const codexVersion = versionResult.output.match(/codex-cli\s+(\S+)/)?.[1] ?? null;
  // The canary: doctor loads the merged config — the worker's exact
  // isolation overrides included — without invoking a model. Its prose is
  // the source of truth (exit codes vary with unrelated notes like a
  // missing login), so health = banner seen AND no config-load signature.
  const doctorResult = await runWorkerCommand("codex", [...CODEX_ISOLATION_CONFIG_ARGS, "doctor"], 20_000);
  const codexConfigOk = doctorResult.output.includes("Codex Doctor") && !CODEX_CONFIG_ERROR_SIGNATURE.test(doctorResult.output);
  const commitResult = await runWorkerCommand("git", ["-C", process.cwd(), "rev-parse", "--short", "HEAD"], 5_000);
  const workerCommit = commitResult.code === 0 ? commitResult.output.trim().split("\n")[0] || null : null;
  let dbSchemaOk = null;
  if (dbClient) {
    try {
      const schemaResult = await dbClient.query(
        "SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='agent_runs' AND column_name='available_at'",
      );
      dbSchemaOk = schemaResult.rows[0].n === 1;
    } catch {
      dbSchemaOk = false;
    }
  }
  const selfCheckOk = codexConfigOk && dbSchemaOk !== false;
  if (selfCheckOk) codexConfigSuspect = false;
  return {
    codex_config_ok: codexConfigOk,
    codex_version: codexVersion,
    worker_commit: workerCommit,
    db_schema_ok: dbSchemaOk,
    openai_key_configured: Boolean(process.env.OPENAI_API_KEY),
    self_check_ok: selfCheckOk,
    self_check_at: new Date().toISOString(),
  };
}

// Execute prompt via local Codex CLI
async function runCodexPrompt(prompt) {
  const workspace = await mkdtemp(join(tmpdir(), "companyos-worker-"));
  try {
    return await new Promise((resolveRun, rejectRun) => {
      // Pass only the environment the Codex CLI process itself needs (PATH and
      // its credential home). Model tool calls do not inherit it: see
      // shell_environment_policy above. Undefined entries are dropped so no
      // literal "undefined" values reach the child process.
      const env = Object.fromEntries(
        Object.entries({
          NODE_ENV: "production",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USER: process.env.USER,
          CODEX_HOME: process.env.CODEX_HOME,
          USERPROFILE: process.env.USERPROFILE,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          TERM: "dumb",
        }).filter(([, value]) => value !== undefined),
      );
      const args = [
        "exec", "--json", "--ephemeral", "--ignore-user-config",
        "--cd", workspace, "--skip-git-repo-check",
        ...CODEX_ISOLATION_CONFIG_ARGS,
        "-",
      ];
      const child = spawn("codex", args, { cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let overflow = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 120_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stdout.length + chunk.length > 300_000) {
          overflow = true;
          child.kill();
          return;
        }
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 5000) stderr += chunk;
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        rejectRun(new Error(`Failed to start Codex CLI: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) return rejectRun(new Error("Codex CLI timed out after 120s."));
        if (overflow) return rejectRun(new Error("Codex CLI output exceeded limit."));
        if (code !== 0) {
          // Circuit breaker: a config-load failure means the substrate —
          // not the task — is broken. Flag it so the next maintenance
          // window re-runs the self-check and the claim gate closes until
          // the check passes again.
          if (CODEX_CONFIG_ERROR_SIGNATURE.test(stderr)) codexConfigSuspect = true;
          const errDetail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : "";
          return rejectRun(new Error(`Codex CLI exited with code ${code}${errDetail}`));
        }
        const messages = [];
        for (const line of stdout.split(/\r?\n/)) {
          try {
            const event = JSON.parse(line);
            if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
              messages.push(event.item.text);
            }
          } catch {}
        }
        const text = messages.at(-1);
        if (!text) return rejectRun(new Error("Codex CLI completed without a text response."));
        resolveRun({ text, model: "Codex CLI · isolated" });
      });
      child.stdin.end(prompt);
    });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Image-generation bridge (mirror of generateImageTool in
// lib/ai/tool-registry.ts). An owner-approved generate_image proposal queues
// a normal execution task whose run input carries an image_generation spec.
// When this worker claims such a run in database mode, execution is
// DETERMINISTIC — no model session is involved: the worker itself spawns
// the imagegen skill's CLI fallback (scripts/image_gen.py, GPT Image
// models) with a JSONL batch of the approved prompt, collects the image
// files from the run's output directory, and uploads each one to the app's
// server endpoint. The skill's built-in image_gen tool is NOT used: it is
// unavailable in headless sessions (verified on this host), and the CLI
// requires OPENAI_API_KEY in this worker's own environment. WordPress
// credentials live on the server and are never present here.
// ---------------------------------------------------------------------------
const IMAGE_GENERATION_PURPOSES = new Set(["social post", "website", "other"]);
const IMAGE_GENERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATED_IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;

function parseImageGenerationSpec(raw) {
  if (!raw || typeof raw !== "object") return null;
  const prompt = boundedText(raw.prompt, 1000);
  if (prompt.length < 3) return null;
  const count = Number.isInteger(raw.count) && raw.count >= 1 && raw.count <= 4 ? raw.count : 3;
  const purpose = IMAGE_GENERATION_PURPOSES.has(raw.purpose) ? raw.purpose : "other";
  const contentItemId = typeof raw.content_item_id === "string" && IMAGE_GENERATION_UUID.test(raw.content_item_id) ? raw.content_item_id : null;
  return { prompt, count, purpose, contentItemId };
}

async function collectImageFiles(directory, { depth = 0 } = {}) {
  if (!directory || depth > 4) return [];
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectImageFiles(full, { depth: depth + 1 }));
    } else if (entry.isFile()) {
      const contentType = GENERATED_IMAGE_TYPES[extname(entry.name).toLowerCase()];
      if (!contentType) continue;
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      files.push({ path: full, name: entry.name, contentType, mtimeMs: info.mtimeMs });
    }
  }
  return files;
}

function spawnImageGenCli(script, args) {
  return new Promise((resolveRun, rejectRun) => {
    // Only the environment the CLI itself needs: interpreter paths, the
    // Codex home (for skill-relative config), and the OpenAI key. The key
    // is passed to the child process only — never logged or returned.
    const env = Object.fromEntries(
      Object.entries({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        CODEX_HOME: process.env.CODEX_HOME,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TERM: "dumb",
      }).filter(([, value]) => value !== undefined),
    );
    const child = spawn("python3", [script, ...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 240_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 5000) stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 5000) stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectRun(new Error(`Failed to start the imagegen CLI: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return rejectRun(new Error("Image generation CLI timed out after 240s."));
      if (code !== 0) {
        const errDetail = stderr.trim() ? `: ${stderr.trim().slice(-300)}` : "";
        return rejectRun(new Error(`Image generation CLI exited with code ${code}${errDetail}`));
      }
      resolveRun();
    });
  });
}

// Runs the imagegen CLI for one approved spec: one JSONL job per requested
// variation of the same prompt, written into a fresh output directory the
// worker then collects. Generation gets a 240s budget (inside the 5-minute
// worker lease the claim sweeps use).
async function runImageGenerationCli(spec) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the worker.");
  }
  const codexHome = process.env.CODEX_HOME || (process.env.HOME ? join(process.env.HOME, ".codex") : "");
  const script = codexHome ? join(codexHome, "skills", ".system", "imagegen", "scripts", "image_gen.py") : "";
  if (!script || !(await stat(script).catch(() => null))) {
    throw new Error("The imagegen CLI (skills/.system/imagegen/scripts/image_gen.py) was not found on the worker.");
  }
  const workspace = await mkdtemp(join(tmpdir(), "companyos-worker-images-"));
  try {
    const outDir = join(workspace, "output");
    await mkdir(outDir, { recursive: true });
    const inputPath = join(workspace, "prompts.jsonl");
    const jobs = Array.from({ length: spec.count }, () => JSON.stringify({ prompt: spec.prompt }));
    await writeFile(inputPath, `${jobs.join("\n")}\n`, "utf8");
    await spawnImageGenCli(script, ["generate-batch", "--input", inputPath, "--out-dir", outDir, "--force"]);
    const found = await collectImageFiles(outDir);
    const files = [];
    for (const candidate of found.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      const data = await readFile(candidate.path).catch(() => null);
      if (!data?.length || data.length > MAX_GENERATED_IMAGE_BYTES) continue;
      files.push({ name: candidate.name, contentType: candidate.contentType, data });
    }
    return { files };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function uploadGeneratedImage(file, spec) {
  const baseUrl = (process.env.APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (process.env.COMPANYOS_ADMIN_TOKEN) headers.Authorization = `Bearer ${process.env.COMPANYOS_ADMIN_TOKEN}`;
  const response = await fetch(`${baseUrl}/api/content/images/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      filename: file.name,
      content_type: file.contentType,
      data_base64: file.data.toString("base64"),
      ...(spec.contentItemId ? { content_item_id: spec.contentItemId } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Image upload failed (HTTP ${response.status}).`);
  const result = await response.json().catch(() => null);
  if (!result?.url) throw new Error("Image upload returned no URL.");
  return result.url;
}

async function executeImageGenerationRun(pool, claimed, task, spec) {
  try {
    console.log(`[Worker] Generating image(s) for run ${claimed.id}: "${spec.prompt.slice(0, 80)}"...`);
    const generated = await runImageGenerationCli(spec);
    if (!generated.files.length) throw new Error("Image generation produced no image files.");
    const urls = [];
    for (const file of generated.files.slice(0, spec.count)) {
      urls.push(await uploadGeneratedImage(file, spec));
    }
    if (!urls.length) throw new Error("Image generation produced no image files.");
    const summary = `Generated ${urls.length} image variation(s): ${urls.join(", ")}`;
    await pool.query(
      "UPDATE agent_runs SET provider='codex-cli',model=$2,status='completed',summary=$3,result=$4::jsonb,completed_at=NOW() WHERE id=$1",
      [claimed.id, "imagegen CLI · GPT Image", summary.slice(0, 500), JSON.stringify({ text: summary, image_urls: urls, image_generation: spec })],
    );
    await pool.query("UPDATE workflow_dispatches SET status='completed' WHERE agent_run_id=$1", [claimed.id]);
    await pool.query(
      "INSERT INTO events (source,event_type,title,severity,payload) VALUES ('agent-worker','image_generation_completed',$1,'info',$2::jsonb)",
      [`Image generation completed on VM: ${task.title}`, JSON.stringify({ run_id: claimed.id, task_id: task.id, image_urls: urls, content_item_id: spec.contentItemId })],
    );
    console.log(`[Worker] ✓ Image generation run ${claimed.id} finished (${urls.length} image(s) uploaded).`);
  } catch (err) {
    console.error(`[Worker] ✗ Image generation failed for run ${claimed.id}:`, err.message);
    await pool.query(
      "UPDATE agent_runs SET status='failed',error=$2,summary='Image generation failed on VM.',completed_at=NOW() WHERE id=$1",
      [claimed.id, err.message.slice(0, 400)],
    );
    await pool.query("UPDATE workflow_dispatches SET status='failed' WHERE agent_run_id=$1", [claimed.id]);
  }
}

// Database direct mode (opt-in via COMPANYOS_WORKER_MODE=db; see above)
if (useDatabaseMode) {
  // SSL rule mirrors resolveDatabaseSsl in lib/db-ssl.ts (this standalone
  // script cannot import it; tests/worker-ssl-parity.test.ts pins parity):
  // SSL on per the host/sslmode decision below, certificates verified by
  // default, and only an explicit sslmode=no-verify — captured here, before
  // sslmode is stripped from the URL — opts out of verification.
  let dbUrl = process.env.DATABASE_URL;
  const isLocal = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");
  const isSslDisabled = dbUrl.includes("sslmode=disable");
  const sslNoVerify = dbUrl.includes("sslmode=no-verify");
  const useSsl = (!isLocal && !isSslDisabled) || dbUrl.includes("supabase") || (dbUrl.includes("sslmode=") && !isSslDisabled) || dbUrl.includes("render.com") || dbUrl.includes("neon.tech");
  const rejectUnauthorized = !sslNoVerify;
  dbUrl = dbUrl.replace(/([?&])sslmode=[^&]*(&|$)/, "$1").replace(/[?&]$/, "");

  const pool = new Pool({
    connectionString: dbUrl,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ...(useSsl ? { ssl: { rejectUnauthorized } } : {}),
  });

  const workerId = randomUUID();
  console.log(`CompanyOS autonomous database worker started (Worker ID: ${workerId}).`);
  console.log(`Polling Supabase / PostgreSQL every ${interval}ms for queued agent runs...`);

  // Maintenance (the heartbeat write + Codex status check, and the lease
  // expiry sweep) runs at most once per maintenance window instead of on
  // every poll, so idle polls between windows are read-only run claims
  // with no write churn. Claiming itself stays on the poll interval.
  const MAINTENANCE_INTERVAL_MS = 30_000;
  let lastMaintenanceAt = 0;
  const SELF_CHECK_INTERVAL_MS = 300_000;
  let workerSelfCheck = null;
  let lastSelfCheckAt = 0;

  while (!stopping) {
    let client = null;
    try {
      client = await pool.connect();

      if (Date.now() - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
        lastMaintenanceAt = Date.now();

        // Self-check on startup, on the cadence, and immediately when the
        // circuit breaker suspects a config-load failure. The result rides
        // in the heartbeat so the app can show worker health as a system
        // check ("Codex:worker-health" in lib/data.ts).
        if (workerSelfCheck === null || codexConfigSuspect || Date.now() - lastSelfCheckAt >= SELF_CHECK_INTERVAL_MS) {
          workerSelfCheck = await runWorkerSelfCheck(client);
          lastSelfCheckAt = Date.now();
          if (workerSelfCheck.self_check_ok) {
            console.log(`[Worker Self-Check] OK (codex ${workerSelfCheck.codex_version ?? "?"}, commit ${workerSelfCheck.worker_commit ?? "?"}).`);
          } else {
            console.error(`[Worker Self-Check] UNHEALTHY: ${JSON.stringify(workerSelfCheck)} — not claiming runs until the self-check passes.`);
          }
        }

        // Update heartbeat. Agent permissions are owner-managed (seed/schema
        // grants only); this worker must never re-grant them at runtime.
        const codexStatus = await checkCodexStatus();
        await client.query(
          `INSERT INTO runtime_heartbeats (service_name,instance_id,status,details,last_seen_at)
           VALUES ('agent-worker',$1,$2,$3::jsonb,NOW())
           ON CONFLICT (service_name) DO UPDATE SET instance_id=EXCLUDED.instance_id,status=EXCLUDED.status,details=EXCLUDED.details,last_seen_at=NOW()`,
          [
            workerId,
            codexStatus.authenticated && (!workerSelfCheck || workerSelfCheck.self_check_ok) ? "online" : "degraded",
            JSON.stringify({ codex_cli_authenticated: codexStatus.authenticated, ...(workerSelfCheck ?? {}) }),
          ],
        );

        // Expire runs whose worker lease has lapsed (mirrors the HTTP worker
        // route, scoped to this mode's running summary), so a worker killed
        // mid-run does not leave the run 'running' forever.
        await client.query(
          `WITH expired AS (
             UPDATE agent_runs SET status='failed',error='Worker lease expired.',summary='Worker lease expired.',completed_at=NOW()
             WHERE status='running' AND summary='Worker running on VM.' AND started_at < NOW()-INTERVAL '5 minutes'
             RETURNING id
           )
           UPDATE workflow_dispatches SET status='failed' WHERE agent_run_id IN (SELECT id FROM expired)`,
        );
      }

      // Claim next queued run. The self-check gate ($1) closes claiming
      // while the substrate is known-broken: the candidate set is empty,
      // the run stays queued, and the heartbeat/system check carries the
      // reason instead of every task failing identically.
      const mayClaim = !workerSelfCheck || workerSelfCheck.self_check_ok;
      await client.query("BEGIN");
      const claimResult = await client.query(
        `WITH candidate AS (
           SELECT id FROM agent_runs WHERE status='queued' AND provider IN ('codex-cli', 'auto', 'agnostic')
             AND (available_at IS NULL OR available_at <= NOW()) AND $1::boolean
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE agent_runs r SET status='running',summary='Worker running on VM.',started_at=NOW(),error=NULL
         FROM candidate c WHERE r.id=c.id RETURNING r.id,r.task_id,r.input`,
        [mayClaim],
      );
      const claimed = claimResult.rows[0] ?? null;
      if (claimed) {
        await client.query("UPDATE workflow_dispatches SET status='running' WHERE agent_run_id=$1", [claimed.id]);
        await client.query("COMMIT");

        console.log(`[Worker] Claimed run ${claimed.id} for task ${claimed.task_id}...`);

        // Get task and agent details
        const taskRes = await pool.query(
          `SELECT t.id,t.title,t.priority,t.status,t.project_id,
             p.name AS project_name,a.id AS agent_id,a.name AS agent_name,a.role AS agent_role,a.mission AS agent_mission,
             a.description AS agent_description,a.memory_scope AS agent_memory_scope,a.allowed_actions AS agent_allowed_actions,manager.name AS agent_manager_name,
             COALESCE((SELECT json_agg(json_build_object('id',child.id,'name',child.name,'role',child.role)) FROM agents child WHERE child.reports_to=a.id),'[]'::json) AS agent_direct_reports
           FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN agents a ON a.id=t.agent_id
           LEFT JOIN agents manager ON manager.id=a.reports_to WHERE t.id=$1`, [claimed.task_id],
        );
        const task = taskRes.rows[0];
        const imageSpec = parseImageGenerationSpec(claimed.input?.image_generation);

        if (!task || task.status === "done" || !task.agent_id) {
          await pool.query(
            "UPDATE agent_runs SET status='failed',error='Queued task is missing, complete, or unassigned.',summary='Task could not start.',completed_at=NOW() WHERE id=$1",
            [claimed.id],
          );
          console.log(`[Worker] Run ${claimed.id} failed: task missing or complete.`);
        } else if (imageSpec) {
          // Image-generation bridge: this run exists only to generate the
          // owner-approved image(s) in its input spec; the dedicated
          // branch generates, uploads, and finalizes the run itself.
          await executeImageGenerationRun(pool, claimed, task, imageSpec);
        } else {
          // Construct prompt, preferring existing input prompt if available
          const role = task.agent_name ? `${task.agent_name}${task.agent_role ? ` (${task.agent_role})` : ""}` : "CompanyOS task agent";
          const canGenerateImagesFallback = Array.isArray(task.agent_allowed_actions) && task.agent_allowed_actions.includes("request_image_generation");
          const prompt = claimed.input?.prompt || [
            `You are acting as ${role} for CompanyOS.`,
            task.agent_mission ? `Mission: ${task.agent_mission}` : "",
            `Project: ${task.project_name ?? "Company-wide"}`,
            `Task: ${task.title}`,
            // Backstop for runs queued without a stored prompt: without
            // this, an agent asked for an image reaches for Codex's
            // built-in image tool, which the sandbox's approval policy
            // ("never") always refuses.
            canGenerateImagesFallback ? `You have NO direct image-generation tool here (the built-in one is disabled). To create an image, return a proposed_actions entry {"type":"generate_image","prompt":"<full image description>","count":1,"purpose":"social post","reason":"<why>"}.` : "",
            `Return one JSON object: {"summary":"...","work_completed":[],"evidence":[],"risks":[],"next_actions":[],"proposed_actions":[]}`,
          ].filter(Boolean).join("\n");

          try {
            console.log(`[Worker] Executing Codex CLI for task: "${task.title}"...`);
            const execResult = await runCodexPrompt(prompt);
            await pool.query(
              "UPDATE agent_runs SET provider='codex-cli',model=$2,status='completed',summary=$3,result=$4::jsonb,completed_at=NOW() WHERE id=$1",
              [claimed.id, execResult.model, execResult.text.slice(0, 500), JSON.stringify({ text: execResult.text })],
            );
            await pool.query("UPDATE workflow_dispatches SET status='completed' WHERE agent_run_id=$1", [claimed.id]);

            // Parse and record any proposed actions directly into approvals
            let proposalCount = 0;
            try {
              const start = execResult.text.indexOf("{");
              const end = execResult.text.lastIndexOf("}");
              if (start >= 0 && end > start) {
                const parsed = JSON.parse(execResult.text.slice(start, end + 1));
                if (Array.isArray(parsed.proposed_actions)) {
                  // Mirror publishWordPressPostTool in lib/ai/tool-registry.ts:
                  // only agents that hold request_wordpress_publish may propose
                  // a publish, the run must be project-scoped, and fields are
                  // bounded the same way before anything reaches approvals.
                  const canPublishWordPress = Array.isArray(task.agent_allowed_actions) && task.agent_allowed_actions.includes("request_wordpress_publish");
                  for (const [idx, prop] of parsed.proposed_actions.slice(0, 5).entries()) {
                    if (prop?.type !== "publish_wordpress_post" || !canPublishWordPress || !task.project_id) continue;
                    const title = boundedText(prop.title, 200);
                    const content = typeof prop.content === "string" ? prop.content.trim().slice(0, 50_000) : "";
                    const reason = boundedText(prop.reason, 500);
                    if (!title || !content || !reason) continue;
                    await pool.query(
                      `INSERT INTO approvals (project_id,requested_by,action,risk_level,reason,agent_run_id,agent_id,action_type,proposal_index,payload)
                       VALUES ($1,$2,$3,'high',$4,$5,$6,'publish_wordpress_post',$7,$8::jsonb)
                       ON CONFLICT (agent_run_id,proposal_index) WHERE agent_run_id IS NOT NULL AND proposal_index IS NOT NULL DO NOTHING`,
                      [task.project_id, task.agent_name ?? "Agent", `Publish WordPress draft: ${title}`, reason, claimed.id, task.agent_id, idx, JSON.stringify({ title, content })],
                    );
                    proposalCount += 1;
                  }
                  // Mirror the WordPress full-access tools in
                  // lib/ai/tool-registry.ts (publish_wordpress_page,
                  // upload_wordpress_media, update_wordpress_settings,
                  // update_wordpress_menu): only agents that hold
                  // request_wordpress_manage may propose site management,
                  // the run must be project-scoped, and fields are bounded
                  // the same way before anything reaches approvals. Payload
                  // shapes and approval labels match the registry exactly
                  // so an approved row executes identically in both modes.
                  const canManageWordPress = Array.isArray(task.agent_allowed_actions) && task.agent_allowed_actions.includes("request_wordpress_manage");
                  if (canManageWordPress && task.project_id) {
                    const wpInt = (value, min, max) => {
                      const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
                      return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
                    };
                    const wpSlug = (value) => {
                      const slug = boundedText(value, 200).toLowerCase();
                      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : "";
                    };
                    const wpHttpUrl = (value) => {
                      try {
                        const parsed = new URL(value);
                        return parsed.protocol === "http:" || parsed.protocol === "https:";
                      } catch {
                        return false;
                      }
                    };
                    const insertWpApproval = async (idx, actionType, actionLabel, reason, payload) => {
                      await pool.query(
                        `INSERT INTO approvals (project_id,requested_by,action,risk_level,reason,agent_run_id,agent_id,action_type,proposal_index,payload)
                         VALUES ($1,$2,$3,'high',$4,$5,$6,$7,$8,$9::jsonb)
                         ON CONFLICT (agent_run_id,proposal_index) WHERE agent_run_id IS NOT NULL AND proposal_index IS NOT NULL DO NOTHING`,
                        [task.project_id, task.agent_name ?? "Agent", actionLabel, reason, claimed.id, task.agent_id, actionType, idx, JSON.stringify(payload)],
                      );
                      proposalCount += 1;
                    };
                    for (const [idx, prop] of parsed.proposed_actions.slice(0, 5).entries()) {
                      const reason = boundedText(prop?.reason, 500);
                      if (!reason) continue;
                      if (prop?.type === "publish_wordpress_page") {
                        const title = boundedText(prop.title, 200);
                        const content = typeof prop.content === "string" ? prop.content.trim().slice(0, 50_000) : "";
                        const pageId = wpInt(prop.page_id, 1, 2_147_483_647);
                        const slug = wpSlug(prop.slug);
                        const status = prop.status === "publish" ? "publish" : "draft";
                        if (!content || !(title || pageId)) continue;
                        const label = pageId
                          ? `Update WordPress page #${pageId} (${status === "publish" ? "LIVE" : "draft"}): ${title}`
                          : `Publish WordPress page ${status === "publish" ? "LIVE" : "draft"}: ${title}`;
                        await insertWpApproval(idx, "publish_wordpress_page", label, reason, { page_id: pageId ?? null, slug, title, content, status });
                      } else if (prop?.type === "upload_wordpress_media") {
                        const sourceUrl = boundedText(prop.source_url, 1000);
                        const title = boundedText(prop.title, 200);
                        const altText = boundedText(prop.alt_text, 300);
                        if (!sourceUrl || !wpHttpUrl(sourceUrl)) continue;
                        await insertWpApproval(idx, "upload_wordpress_media", `Upload media to WordPress: ${title || sourceUrl}`, reason, { source_url: sourceUrl, title, alt_text: altText });
                      } else if (prop?.type === "update_wordpress_settings") {
                        const payload = {};
                        const parts = [];
                        if (typeof prop.title === "string") { payload.title = boundedText(prop.title, 200); parts.push(`site title → "${payload.title}"`); }
                        if (typeof prop.description === "string") { payload.description = boundedText(prop.description, 300); parts.push(`tagline → "${payload.description}"`); }
                        if (prop.show_on_front === "page" || prop.show_on_front === "posts") { payload.show_on_front = prop.show_on_front; parts.push(`homepage shows → ${prop.show_on_front === "page" ? "a static page" : "latest posts"}`); }
                        const pageOnFront = wpInt(prop.page_on_front, 1, 2_147_483_647);
                        if (pageOnFront !== undefined) { payload.page_on_front = pageOnFront; parts.push(`homepage page → #${pageOnFront}`); }
                        if (!parts.length) continue;
                        await insertWpApproval(idx, "update_wordpress_settings", `Update WordPress site settings: ${parts.join("; ")}`, reason, payload);
                      } else if (prop?.type === "update_wordpress_menu") {
                        const menuId = wpInt(prop.menu_id, 1, 2_147_483_647);
                        const items = [];
                        let itemsValid = Array.isArray(prop.items) && prop.items.length > 0;
                        if (itemsValid) {
                          for (const [itemIndex, entry] of prop.items.slice(0, 30).entries()) {
                            const title = boundedText(entry?.title, 100);
                            const url = boundedText(entry?.url, 500);
                            const parentIndex = wpInt(entry?.parent_index, 0, 29);
                            if (!title || !url || !wpHttpUrl(url) || (parentIndex !== undefined && parentIndex >= itemIndex)) { itemsValid = false; break; }
                            items.push({ title, url, ...(parentIndex !== undefined ? { parent_index: parentIndex } : {}) });
                          }
                        }
                        if (!menuId || !itemsValid || !items.length) continue;
                        const titles = items.map((item) => item.title).join(", ");
                        await insertWpApproval(idx, "update_wordpress_menu", `Replace WordPress menu #${menuId} items (${items.length}): ${titles.slice(0, 160)}`, reason, { menu_id: menuId, items });
                      }
                    }
                  }
                  // Mirror manageProxmoxContainerTool in
                  // lib/ai/tool-registry.ts: only the DevOps agent holding
                  // request_proxmox_manage may propose Proxmox LXC
                  // management, the run must be project-scoped, and fields
                  // are bounded the same way before anything reaches
                  // approvals. Payload shapes and approval labels match the
                  // registry exactly so an approved row executes
                  // identically in both modes. The action allowlist is the
                  // same six actions; destructive operations do not exist
                  // in either mode.
                  const canManageProxmox = Array.isArray(task.agent_allowed_actions) && task.agent_allowed_actions.includes("request_proxmox_manage")
                    && typeof task.agent_name === "string" && task.agent_name.toLowerCase() === "devops";
                  if (canManageProxmox && task.project_id) {
                    const pveInt = (value, min, max) => {
                      const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
                      return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
                    };
                    const pveNode = (value) => {
                      const node = boundedText(value, 63);
                      return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(node) ? node : "";
                    };
                    const pveSnapshotName = (value) => {
                      const name = boundedText(value, 40);
                      return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) && name.toLowerCase() !== "current" ? name : "";
                    };
                    const pveActions = new Set(["start", "shutdown", "stop", "reboot", "snapshot", "resize"]);
                    const pveResizeParts = (cores, currentCores, memoryMb, currentMemoryMb, swapMb, currentSwapMb) => {
                      const parts = [];
                      if (cores !== undefined && currentCores !== undefined && cores !== currentCores) parts.push(`cores ${currentCores} → ${cores}`);
                      if (memoryMb !== undefined && currentMemoryMb !== undefined && memoryMb !== currentMemoryMb) parts.push(`memory ${currentMemoryMb} MB → ${memoryMb} MB`);
                      if (swapMb !== undefined && currentSwapMb !== undefined && swapMb !== currentSwapMb) parts.push(`swap ${currentSwapMb} MB → ${swapMb} MB`);
                      return parts;
                    };
                    for (const [idx, prop] of parsed.proposed_actions.slice(0, 5).entries()) {
                      if (prop?.type !== "manage_proxmox_container") continue;
                      const reason = boundedText(prop?.reason, 500);
                      const node = pveNode(prop.node);
                      const vmid = pveInt(prop.vmid, 100, 999_999_999);
                      const containerName = boundedText(prop.container_name, 120);
                      const action = pveActions.has(prop.action) ? prop.action : undefined;
                      if (!reason || !node || !vmid || !action) continue;
                      const target = `LXC ${vmid}${containerName ? ` "${containerName}"` : ""} on ${node}`;
                      let label = "";
                      let payload = null;
                      if (action === "snapshot") {
                        const snapshotName = pveSnapshotName(prop.snapshot_name);
                        if (!snapshotName) continue;
                        label = `Snapshot Proxmox ${target} as "${snapshotName}"`;
                        payload = { node, vmid, container_name: containerName, action, snapshot_name: snapshotName };
                      } else if (action === "resize") {
                        const cores = pveInt(prop.cores, 1, 64);
                        const memoryMb = pveInt(prop.memory_mb, 128, 131072);
                        const swapMb = pveInt(prop.swap_mb, 0, 65536);
                        const currentCores = pveInt(prop.current_cores, 1, 64);
                        const currentMemoryMb = pveInt(prop.current_memory_mb, 128, 131072);
                        const currentSwapMb = pveInt(prop.current_swap_mb, 0, 65536);
                        const anyChange = cores !== undefined || memoryMb !== undefined || swapMb !== undefined;
                        const missingBefore = (cores !== undefined && currentCores === undefined)
                          || (memoryMb !== undefined && currentMemoryMb === undefined)
                          || (swapMb !== undefined && currentSwapMb === undefined);
                        const parts = pveResizeParts(cores, currentCores, memoryMb, currentMemoryMb, swapMb, currentSwapMb);
                        if (!anyChange || missingBefore || !parts.length) continue;
                        label = `Resize Proxmox ${target}: ${parts.join("; ")}`;
                        payload = {
                          node, vmid, container_name: containerName, action,
                          ...(cores !== undefined && cores !== currentCores ? { cores, current_cores: currentCores } : {}),
                          ...(memoryMb !== undefined && memoryMb !== currentMemoryMb ? { memory_mb: memoryMb, current_memory_mb: currentMemoryMb } : {}),
                          ...(swapMb !== undefined && swapMb !== currentSwapMb ? { swap_mb: swapMb, current_swap_mb: currentSwapMb } : {}),
                        };
                      } else {
                        const verb = action === "start" ? "Start" : action === "shutdown" ? "Shut down" : action === "stop" ? "Stop" : "Reboot";
                        label = `${verb} Proxmox ${target}`;
                        payload = { node, vmid, container_name: containerName, action };
                      }
                      await pool.query(
                        `INSERT INTO approvals (project_id,requested_by,action,risk_level,reason,agent_run_id,agent_id,action_type,proposal_index,payload)
                         VALUES ($1,$2,$3,'high',$4,$5,$6,'manage_proxmox_container',$7,$8::jsonb)
                         ON CONFLICT (agent_run_id,proposal_index) WHERE agent_run_id IS NOT NULL AND proposal_index IS NOT NULL DO NOTHING`,
                        [task.project_id, task.agent_name ?? "Agent", label, reason, claimed.id, task.agent_id, idx, JSON.stringify(payload)],
                      );
                      proposalCount += 1;
                    }
                  }
                  // Mirror createContentItemTool in lib/ai/tool-registry.ts:
                  // only agents that hold request_content_item may propose
                  // planner content, the run must be project-scoped, and
                  // fields are bounded the same way before approvals.
                  const canProposeContent = Array.isArray(task.agent_allowed_actions) && task.agent_allowed_actions.includes("request_content_item");
                  const contentTypes = new Set(["post", "reel", "story", "article"]);
                  for (const [idx, prop] of parsed.proposed_actions.slice(0, 5).entries()) {
                    if (prop?.type !== "create_content_item" || !canProposeContent || !task.project_id) continue;
                    const title = boundedText(prop.title, 160);
                    const contentType = typeof prop.content_type === "string" && contentTypes.has(prop.content_type) ? prop.content_type : "";
                    const caption = boundedText(prop.caption, 2200);
                    const imagePrompt = boundedText(prop.image_prompt, 500);
                    const reason = boundedText(prop.reason, 500);
                    const scheduledRaw = typeof prop.scheduled_for === "string" ? prop.scheduled_for.trim().match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "" : "";
                    const scheduledFor = scheduledRaw && !Number.isNaN(new Date(`${scheduledRaw}T12:00:00Z`).getTime()) ? scheduledRaw : "";
                    if (title.length < 3 || !contentType || reason.length < 8) continue;
                    await pool.query(
                      `INSERT INTO approvals (project_id,requested_by,action,risk_level,reason,agent_run_id,agent_id,action_type,proposal_index,payload)
                       VALUES ($1,$2,$3,'medium',$4,$5,$6,'create_content_item',$7,$8::jsonb)
                       ON CONFLICT (agent_run_id,proposal_index) WHERE agent_run_id IS NOT NULL AND proposal_index IS NOT NULL DO NOTHING`,
                      [task.project_id, task.agent_name ?? "Agent", `Add to content planner (${contentType}): ${title}`, reason, claimed.id, task.agent_id, idx, JSON.stringify({ title, content_type: contentType, caption, image_prompt: imagePrompt, scheduled_for: scheduledFor })],
                    );
                    proposalCount += 1;
                  }
                  // Mirror generateImageTool in lib/ai/tool-registry.ts:
                  // EVERY agent holding request_image_generation may
                  // propose image generation (no role restriction), the
                  // task's project may be null (company-wide / client
                  // work), and fields are bounded the same way before
                  // anything reaches approvals.
                  // Payload shape and approval label match the registry
                  // exactly so an approved row executes identically in
                  // both modes.
                  const canGenerateImages = Array.isArray(task.agent_allowed_actions) && task.agent_allowed_actions.includes("request_image_generation");
                  const imagePurposes = new Set(["social post", "website", "other"]);
                  for (const [idx, prop] of parsed.proposed_actions.slice(0, 5).entries()) {
                    if (prop?.type !== "generate_image" || !canGenerateImages) continue;
                    const promptText = boundedText(prop.prompt, 1000);
                    const reason = boundedText(prop.reason, 500);
                    const count = Number.isInteger(prop.count) && prop.count >= 1 && prop.count <= 4 ? prop.count : 3;
                    const purpose = imagePurposes.has(prop.purpose) ? prop.purpose : "other";
                    const contentItemId = typeof prop.content_item_id === "string" && IMAGE_GENERATION_UUID.test(prop.content_item_id) ? prop.content_item_id : null;
                    if (prop.content_item_id && !contentItemId) continue;
                    if (promptText.length < 3 || reason.length < 8) continue;
                    await pool.query(
                      `INSERT INTO approvals (project_id,requested_by,action,risk_level,reason,agent_run_id,agent_id,action_type,proposal_index,payload)
                       VALUES ($1,$2,$3,'high',$4,$5,$6,'generate_image',$7,$8::jsonb)
                       ON CONFLICT (agent_run_id,proposal_index) WHERE agent_run_id IS NOT NULL AND proposal_index IS NOT NULL DO NOTHING`,
                      [task.project_id, task.agent_name ?? "Agent", `Generate image (×${count}, ${purpose}): ${promptText.slice(0, 120)}`, reason, claimed.id, task.agent_id, idx, JSON.stringify({ prompt: promptText, count, purpose, content_item_id: contentItemId })],
                    );
                    proposalCount += 1;
                  }
                }
              }
            } catch (propErr) {
              console.log("[Worker] Note: Could not parse proposals:", propErr.message);
            }

            await pool.query(
              "INSERT INTO events (source,event_type,title,severity,payload) VALUES ('agent-worker','agent_run_completed',$1,'info',$2::jsonb)",
              [`Delegated task run completed on VM: ${task.title}`, JSON.stringify({ run_id: claimed.id, task_id: task.id, provider: "codex-cli", approval_proposals: proposalCount })],
            );
            console.log(`[Worker] ✓ Successfully finished run ${claimed.id}! (${proposalCount} proposal(s) recorded)`);
          } catch (execErr) {
            console.error(`[Worker] ✗ Codex execution failed for run ${claimed.id}:`, execErr.message);
            await pool.query(
              "UPDATE agent_runs SET status='failed',error=$2,summary='Codex execution failed on VM.',completed_at=NOW() WHERE id=$1",
              [claimed.id, execErr.message.slice(0, 400)],
            );
            await pool.query("UPDATE workflow_dispatches SET status='failed' WHERE agent_run_id=$1", [claimed.id]);
          }
        }
      } else {
        await client.query("ROLLBACK");
      }
    } catch (err) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      console.error(`[Worker Error]: ${err.message}`);
    } finally {
      if (client) client.release();
    }
    if (!stopping) await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
  }
  await pool.end();
} else {
  // HTTP polling fallback mode
  const baseUrl = (process.env.APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (process.env.COMPANYOS_ADMIN_TOKEN) headers.Authorization = `Bearer ${process.env.COMPANYOS_ADMIN_TOKEN}`;
  headers["x-companyos-agent-worker-id"] = randomUUID();

  console.log(`CompanyOS agent worker polling ${baseUrl} every ${interval}ms.`);
  while (!stopping) {
    try {
      const response = await fetch(`${baseUrl}/api/agent-runs/worker`, {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(180_000),
      });
      if (response.status === 401 || response.status === 403) {
        console.error(`Agent worker authorization failed (HTTP ${response.status}). Check COMPANYOS_ADMIN_TOKEN.`);
        process.exitCode = 1;
        break;
      }
      if (!response.ok) {
        console.error(`Agent worker endpoint returned HTTP ${response.status}.`);
      } else {
        const result = await response.json();
        if (result.worked && result.kind === "outbound_email") console.log(`Outbound email ${result.outbound_message_id}: ${result.status}.`);
        else if (result.worked) console.log(`Run ${result.run_id}: ${result.status}${result.approval_proposals ? `; ${result.approval_proposals} approval proposal(s)` : ""}.`);
      }
    } catch (error) {
      console.error(`Agent worker could not reach CompanyOS: ${error instanceof Error ? error.message : "connection error"}`);
    }
    if (!stopping) await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
  }
}
console.log("CompanyOS agent worker stopped.");
