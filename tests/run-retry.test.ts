import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";
import {
  AUTOMATIC_RETRY_DELAYS_MS,
  MAX_AUTOMATIC_RETRIES,
  automaticAttemptOf,
  classifyFailure,
  handleFailedRun,
  retryDecision,
} from "../lib/ai/run-retry.ts";

// Retry + escalation guards: a failed agent run is retried a bounded number
// of times when the failure is transient, and otherwise escalated to one
// owner attention item — a result or a notification, never silence.

const read = (path: string) => readFileSync(path, "utf8");

test("failure classification: transient infrastructure hiccups retry", () => {
  const transient = [
    "Codex CLI timed out after 120 seconds.",
    "Codex CLI timed out after 120s.",
    "Worker lease expired.",
    "Could not start Codex CLI. Check its installation and sign-in status.",
    "Failed to start Codex CLI: spawn codex ENOENT",
    "Codex CLI exited with status 1.",
    "Codex CLI exited with code 1: boom",
    "Codex CLI completed without a final text response.",
    "Codex CLI completed without a text response.",
    "ollama: Model provider returned HTTP 500.",
    "Ollama returned no text response.",
  ];
  for (const error of transient) assert.equal(classifyFailure(error), "transient", error);
  // Lease expiry is also carried in the summary.
  assert.equal(classifyFailure(null, "Worker lease expired."), "transient");
});

test("failure classification: permanent failures escalate, unknowns default to permanent", () => {
  const permanent = [
    "Queued task is missing, complete, or unassigned.",
    "No automatic provider satisfies the task execution requirements.",
    "Codex CLI is not installed or CODEX_CLI_PATH is invalid.",
    "Ollama requires OLLAMA_MODEL.",
    // The output limit is permanent on purpose: the same task would overflow again.
    "Codex CLI response exceeded the 300 KB limit.",
    "Codex CLI output exceeded limit.",
    "Model provider returned HTTP 404.",
    "Something entirely unrecognized.",
  ];
  for (const error of permanent) assert.equal(classifyFailure(error), "permanent", error);
  assert.equal(classifyFailure(null), "permanent");
  assert.equal(classifyFailure(undefined, null), "permanent");
});

test("retry decision: at most two automatic retries with growing delays, then escalation", () => {
  assert.equal(MAX_AUTOMATIC_RETRIES, 2);
  assert.deepEqual(retryDecision(0, "transient"), { action: "retry", delayMs: 60_000, nextAttempt: 1 });
  assert.deepEqual(retryDecision(1, "transient"), { action: "retry", delayMs: 300_000, nextAttempt: 2 });
  assert.deepEqual(retryDecision(2, "transient"), { action: "escalate" });
  assert.deepEqual(retryDecision(0, "permanent"), { action: "escalate" });
  assert.deepEqual(AUTOMATIC_RETRY_DELAYS_MS, [60_000, 300_000]);
});

test("automatic attempt counting reads retry_context and ignores manual retries", () => {
  assert.equal(automaticAttemptOf(null), 0);
  assert.equal(automaticAttemptOf({}), 0);
  assert.equal(automaticAttemptOf({ retry_context: { previous_run_id: "x" } }), 0, "manual retries carry no automatic attempt");
  assert.equal(automaticAttemptOf({ retry_context: { automatic: true, automatic_attempt: 1 } }), 1);
  assert.equal(automaticAttemptOf({ retry_context: { automatic: true, automatic_attempt: 2 } }), 2);
  assert.equal(automaticAttemptOf({ retry_context: { automatic_attempt: "2" } }), 0);
  assert.equal(automaticAttemptOf("junk"), 0);
});

test("the retry creator is shared between the manual route and the automatic policy", () => {
  assert.ok(existsSync("lib/ai/failed-run-retry.ts"), "lib/ai/failed-run-retry.ts is missing");
  const creator = read("lib/ai/failed-run-retry.ts");
  assert.match(creator, /export async function createFailedRunRetry/, "the in-transaction creator must be exported");
  assert.match(creator, /retry_of_run_id/, "retries must stay linked to the failed run");
  assert.doesNotMatch(creator, /from "@\//, "the creator must stay loadable by the node test runner (no @/ alias imports)");

  const route = read("app/api/agent-runs/route.ts");
  assert.match(route, /createFailedRunRetry/, "the manual retry route must use the shared creator");
  assert.match(route, /from "@\/lib\/ai\/failed-run-retry"/, "the route must import the shared creator");
  assert.doesNotMatch(route, /INSERT INTO agent_runs \(agent_id,task_id,provider,status,summary,input,retry_of_run_id\)/, "the route must not keep a parallel retry insert");
});

test("the worker route finalizes every failure through the policy and honors retry delays", () => {
  assert.ok(existsSync("lib/ai/run-retry.ts"), "lib/ai/run-retry.ts is missing");
  const policy = read("lib/ai/run-retry.ts");
  assert.match(policy, /MAX_AUTOMATIC_RETRIES = 2/, "automatic retries must be capped at two");
  assert.match(policy, /agent_run_failed/, "escalations must use the agent_run_failed attention type");
  assert.match(policy, /'high'/, "escalations must be high priority");

  const worker = read("app/api/agent-runs/worker/route.ts");
  assert.match(worker, /handleFailedRun/, "the worker route must finalize failures through the policy");
  const calls = worker.match(/await handleFailedRun\(client, /g) ?? [];
  assert.ok(calls.length >= 4, `every failure site must be wired (lease sweep, missing task, no provider, execution); found ${calls.length}`);
  assert.match(worker, /available_at IS NULL OR available_at <= NOW\(\)/, "the claim query must honor delayed retries");

  const schema = read("db/schema.sql");
  assert.match(schema, /ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS available_at/, "schema must add available_at idempotently");

  const script = read("scripts/agent-worker.mjs");
  assert.match(script, /available_at IS NULL OR available_at <= NOW\(\)/, "the worker script's database-mode claim must honor the same delay");
});

// Integration test: needs a migrated PostgreSQL (npm run db:migrate). Skipped when DATABASE_URL is not set.
const url = process.env.DATABASE_URL;

test("handleFailedRun retries transient failures twice, then escalates exactly once", { skip: !url && "DATABASE_URL not set" }, async () => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query("BEGIN");
  try {
    const agentId = (await db.query<{ id: string }>("INSERT INTO agents (name,role,department) VALUES ('Retry Test Agent','Operator','Operations') RETURNING id")).rows[0].id;
    const taskId = (await db.query<{ id: string }>("INSERT INTO tasks (agent_id,title) VALUES ($1,'Retry test: flaky task') RETURNING id", [agentId])).rows[0].id;
    const insertFailedRun = async (error: string, input: Record<string, unknown> = {}, retryOf: string | null = null) => (await db.query<{ id: string }>(
      `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,error,input,retry_of_run_id,completed_at)
       VALUES ($1,$2,'codex-cli','failed','Delegated run failed.',$3,$4::jsonb,$5,NOW()) RETURNING id`,
      [agentId, taskId, error, JSON.stringify(input), retryOf])).rows[0].id;

    // Attempt 0 (original run) times out -> automatic retry 1, held ~60s.
    const original = await insertFailedRun("Codex CLI timed out after 120 seconds.");
    const first = await handleFailedRun(db, original);
    assert.equal(first.action, "retry");
    if (first.action !== "retry") throw new Error("expected a retry");
    const retryOne = (await db.query<{ status: string; available_at: Date; input: { retry_context: { automatic: boolean; automatic_attempt: number } } }>(
      "SELECT status,available_at,input FROM agent_runs WHERE id=$1", [first.retry_run_id])).rows[0];
    assert.equal(retryOne.status, "queued");
    assert.equal(retryOne.input.retry_context.automatic, true);
    assert.equal(retryOne.input.retry_context.automatic_attempt, 1);
    const delayOne = retryOne.available_at.getTime() - Date.now();
    assert.ok(delayOne > 30_000 && delayOne <= 61_000, `first retry should be held about 60s, got ${delayOne}ms`);

    // Attempt 1 times out too -> automatic retry 2, held ~5 minutes.
    await db.query("UPDATE agent_runs SET status='failed',error='Codex CLI timed out after 120 seconds.',completed_at=NOW() WHERE id=$1", [first.retry_run_id]);
    const second = await handleFailedRun(db, first.retry_run_id);
    assert.equal(second.action, "retry");
    if (second.action !== "retry") throw new Error("expected a retry");
    const retryTwo = (await db.query<{ available_at: Date; input: { retry_context: { automatic_attempt: number } } }>(
      "SELECT available_at,input FROM agent_runs WHERE id=$1", [second.retry_run_id])).rows[0];
    assert.equal(retryTwo.input.retry_context.automatic_attempt, 2);
    const delayTwo = retryTwo.available_at.getTime() - Date.now();
    assert.ok(delayTwo > 240_000 && delayTwo <= 301_000, `second retry should be held about 5 minutes, got ${delayTwo}ms`);

    // Attempt 2 fails -> retries exhausted: escalate to one attention item.
    await db.query("UPDATE agent_runs SET status='failed',error='Codex CLI timed out after 120 seconds.',completed_at=NOW() WHERE id=$1", [second.retry_run_id]);
    const third = await handleFailedRun(db, second.retry_run_id);
    assert.equal(third.action, "escalated");
    const items = (await db.query<{ id: string; priority: string; title: string; description: string }>(
      "SELECT id,priority,title,description FROM attention_items WHERE attention_type='agent_run_failed' AND status='open'")).rows;
    assert.equal(items.length, 1);
    assert.equal(items[0].priority, "high");
    assert.match(items[0].title, /Retry Test Agent/);
    assert.match(items[0].title, /flaky task/);
    assert.match(items[0].description, /after 2 automatic retries/);

    // A permanent failure on a new run escalates immediately — and dedupes
    // against the still-open item instead of stacking a second one.
    const permanent = await insertFailedRun("Queued task is missing, complete, or unassigned.");
    const escalated = await handleFailedRun(db, permanent);
    assert.equal(escalated.action, "escalated");
    if (escalated.action !== "escalated") throw new Error("expected an escalation");
    assert.equal(escalated.attention_item_id, items[0].id);
    assert.equal((await db.query("SELECT 1 FROM attention_items WHERE attention_type='agent_run_failed' AND status='open'")).rowCount, 1);

    // Providers the queue cannot re-run are left alone entirely.
    const manual = (await db.query<{ id: string }>(
      `INSERT INTO agent_runs (agent_id,task_id,provider,status,error,completed_at)
       VALUES ($1,$2,'chatgpt-free','failed','Codex CLI timed out after 120 seconds.',NOW()) RETURNING id`, [agentId, taskId])).rows[0].id;
    assert.deepEqual(await handleFailedRun(db, manual), { action: "none", reason: "Provider is not retryable." });
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});
