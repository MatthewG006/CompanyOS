import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { ADMIN_TOKEN, createIsolatedDatabase, type FakeOllama, type IsolatedDatabase, type RunningApp, startApp, startFakeOllama } from "./harness.ts";

// Route tests run the real production build against a throwaway database and a fake Ollama.
// Use `npm run test:routes` (builds first). Skipped without DATABASE_URL, a build, or CREATE DATABASE rights.
const CAP = 3;
const adminUrl = process.env.DATABASE_URL;
let skipReason: string | false = false;
let isolated: IsolatedDatabase | undefined;
if (!adminUrl) skipReason = "DATABASE_URL not set";
else if (!existsSync(".next/BUILD_ID")) skipReason = "no production build; run `npm run test:routes`";
else {
  try { isolated = await createIsolatedDatabase(adminUrl); } catch (error) { skipReason = `cannot create a test database: ${error instanceof Error ? error.message.split("\n")[0] : error}`; }
}

describe("agent run routes", { skip: skipReason }, () => {
  let app: RunningApp;
  let ollama: FakeOllama;
  let db: pg.Client;
  let agentId: string;
  let taskId: string;
  const TITLE = "Route test: summarise the week";

  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
  type Json = Record<string, any>;
  const call = (path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) =>
    fetch(`${app.baseUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? ADMIN_TOKEN}` }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }).then(async (response) => ({ status: response.status, body: await response.json() as Json }));

  const row = async (id: string) => (await db.query("SELECT provider,model,status,error,result,input FROM agent_runs WHERE id=$1", [id])).rows[0];
  const insertRun = async (provider: string, status: string, hoursAgo = 0) => (await db.query<{ id: string }>(
    `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,input,created_at,started_at)
     VALUES ($1,$2,$3,$4,'seeded','{}'::jsonb,NOW() - make_interval(hours => $5::int),NOW() - make_interval(hours => $5::int)) RETURNING id`,
    [agentId, taskId, provider, status, hoursAgo])).rows[0].id;

  before(async () => {
    assert.ok(isolated && adminUrl);
    ollama = await startFakeOllama();
    app = await startApp({ DATABASE_URL: isolated.url, OLLAMA_MODEL: "fake-model", OLLAMA_BASE_URL: ollama.url, AGENT_LOCAL_MAX_RUNS_PER_HOUR: String(CAP) });
    db = new pg.Client({ connectionString: isolated.url });
    await db.connect();
    agentId = (await db.query<{ id: string }>("INSERT INTO agents (name,role,department) VALUES ('Route Test Agent','Operator','Operations') RETURNING id")).rows[0].id;
    taskId = (await db.query<{ id: string }>("INSERT INTO tasks (agent_id,title) VALUES ($1,$2) RETURNING id", [agentId, TITLE])).rows[0].id;
  });
  after(async () => {
    await db?.end();
    await app?.stop();
    await ollama?.close();
    await isolated?.drop();
  });
  const reset = async () => {
    await db.query("TRUNCATE agent_runs, events CASCADE");
    ollama.mode = "ok";
    ollama.prompts.length = 0;
    ollama.formats.length = 0;
  };

  test("rejects requests without the admin token", async () => {
    assert.equal((await call("/api/agent-runs", { token: null })).status, 401);
    assert.equal((await call("/api/agent-runs", { token: "wrong" })).status, 401);
    assert.equal((await call("/api/agent-runs")).status, 200);
  });

  test("GET reports the local cap and that Ollama is configured while Codex is not", async () => {
    await reset();
    const { body } = await call("/api/agent-runs");
    assert.deepEqual(body.local_cap, { limit: CAP, used: 0, capped: false });
    assert.equal(body.providers.ollama, true);
    assert.equal(body.providers["codex-cli"], false);
  });

  test("auto run executes on the local model and records how it was routed", async () => {
    await reset();
    const { status, body } = await call("/api/agent-runs", { body: { task_id: taskId, provider: "auto" } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.status, "completed");
    assert.equal(body.provider, "ollama");
    assert.equal(body.model, "fake-model");
    assert.equal(ollama.prompts.length, 1);
    assert.match(ollama.prompts[0], new RegExp(TITLE));
    assert.equal(ollama.formats[0], "json", "Ollama must be asked for JSON so proposals can be parsed");
    const run = await row(body.run_id);
    assert.equal(run.status, "completed");
    assert.equal(run.provider, "ollama");
    assert.equal(run.result.text, ollama.reply);
    assert.equal(run.input.routing.used, "ollama");
    assert.equal((await db.query("SELECT 1 FROM events WHERE event_type='agent_run_completed' AND payload->>'run_id'=$1", [body.run_id])).rowCount, 1);
  });

  test("auto run falls back to a manual handoff when the local model fails, and the pasted answer completes it once", async () => {
    await reset();
    ollama.mode = "fail";
    const { status, body } = await call("/api/agent-runs", { body: { task_id: taskId, provider: "auto", manual_provider: "claude-free" } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.status, "awaiting_external");
    assert.equal(body.provider, "claude-free");
    assert.equal(body.attempts[0].provider, "ollama");
    assert.ok(body.prompt.includes(TITLE));
    const waiting = await row(body.run_id);
    assert.equal(waiting.status, "awaiting_external");
    assert.equal(waiting.provider, "claude-free");
    assert.equal(waiting.input.routing.attempts[0].provider, "ollama");

    const paste = await call("/api/agent-runs", { method: "PATCH", body: { run_id: body.run_id, output: "Pasted answer from Claude." } });
    assert.equal(paste.status, 200, JSON.stringify(paste.body));
    assert.equal((await row(body.run_id)).status, "completed");
    assert.equal((await call("/api/agent-runs", { method: "PATCH", body: { run_id: body.run_id, output: "again" } })).status, 404);
  });

  test("paste-back validates its input and rejects expired handoffs", async () => {
    await reset();
    assert.equal((await call("/api/agent-runs", { method: "PATCH", body: { run_id: "not-a-uuid", output: "x" } })).status, 400);
    const stale = await insertRun("chatgpt-free", "expired");
    assert.equal((await call("/api/agent-runs", { method: "PATCH", body: { run_id: stale, output: "late" } })).status, 404);
    assert.equal((await row(stale)).status, "expired");
  });

  test("a full local cap skips the model: auto goes to handoff, an explicit request is refused", async () => {
    await reset();
    for (let i = 0; i < CAP; i += 1) await insertRun("ollama", "completed");
    assert.deepEqual((await call("/api/agent-runs")).body.local_cap, { limit: CAP, used: CAP, capped: true });

    const auto = await call("/api/agent-runs", { body: { task_id: taskId, provider: "auto" } });
    assert.equal(auto.body.status, "awaiting_external");
    assert.equal(auto.body.provider, "chatgpt-free");
    assert.deepEqual(auto.body.attempts, []);
    assert.equal(ollama.prompts.length, 0, "the capped model must not be called");

    const explicit = await call("/api/agent-runs", { body: { task_id: taskId, provider: "ollama" } });
    assert.equal(explicit.status, 503);
    assert.match(explicit.body.error, /Local model limit reached/);
    assert.equal(ollama.prompts.length, 0);
  });

  test("an explicit unconfigured provider is refused rather than substituted", async () => {
    await reset();
    const { status, body } = await call("/api/agent-runs", { body: { task_id: taskId, provider: "openai" } });
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(ollama.prompts.length, 0);
  });

  test("worker runs a queued task on the local model when Codex is unavailable", async () => {
    await reset();
    const queued = await insertRun("codex-cli", "queued");
    const { status, body } = await call("/api/agent-runs/worker", { body: {} });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.status, "completed");
    assert.equal(body.run_id, queued);
    const run = await row(queued);
    assert.equal(run.status, "completed");
    assert.equal(run.provider, "ollama");
    assert.equal(run.input.routing.used, "ollama");
    assert.match(ollama.prompts[0], new RegExp(TITLE));
  });

  test("worker records a failed run when the local model fails, and never uses a handoff", async () => {
    await reset();
    ollama.mode = "fail";
    const queued = await insertRun("codex-cli", "queued");
    const { body } = await call("/api/agent-runs/worker", { body: {} });
    assert.equal(body.status, "failed");
    const run = await row(queued);
    assert.equal(run.status, "failed");
    assert.match(run.error, /ollama/i);
    assert.equal((await db.query("SELECT 1 FROM agent_runs WHERE status='awaiting_external'")).rowCount, 0);
  });

  test("worker leaves queued runs alone when the cap is full, and says why", async () => {
    await reset();
    for (let i = 0; i < CAP; i += 1) await insertRun("ollama", "completed");
    const queued = await insertRun("codex-cli", "queued");
    const { status, body } = await call("/api/agent-runs/worker", { body: {} });
    assert.equal(status, 503);
    assert.match(body.error, /Local model limit reached/);
    assert.equal((await row(queued)).status, "queued");
    assert.equal(ollama.prompts.length, 0);
  });

  test("worker expires stale handoffs and leaves fresh ones", async () => {
    await reset();
    const stale = await insertRun("chatgpt-free", "awaiting_external", 49);
    const fresh = await insertRun("chatgpt-free", "awaiting_external", 1);
    const { body } = await call("/api/agent-runs/worker", { body: {} });
    assert.equal(body.handoffs_expired, 1);
    assert.equal((await row(stale)).status, "expired");
    assert.equal((await row(fresh)).status, "awaiting_external");
    assert.equal((await call("/api/agent-runs")).body.run_counts.expired, 1);
  });
});
