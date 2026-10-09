import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { DEFAULT_LOCAL_RUNS_PER_HOUR, capNotice, evaluateLocalCap, localCapStatus, localRunsPerHour } from "../lib/ai/local-cap.ts";

test("local run limit parsing: default, zero disables, invalid falls back", () => {
  assert.equal(localRunsPerHour(undefined), DEFAULT_LOCAL_RUNS_PER_HOUR);
  for (const bad of ["", "  ", "abc", "-1", "2.5", "10001"]) assert.equal(localRunsPerHour(bad), DEFAULT_LOCAL_RUNS_PER_HOUR, bad);
  assert.equal(localRunsPerHour("0"), 0);
  assert.equal(localRunsPerHour("5"), 5);
  assert.equal(localRunsPerHour("10000"), 10_000);
});

test("cap is reached at the limit, never when the limit is 0", () => {
  assert.equal(evaluateLocalCap(29, 30).capped, false);
  assert.equal(evaluateLocalCap(30, 30).capped, true);
  assert.equal(evaluateLocalCap(500, 0).capped, false);
  assert.equal(capNotice(evaluateLocalCap(1, 30)), "");
  assert.match(capNotice(evaluateLocalCap(30, 30)), /30 of 30 runs in the last hour/);
});

test("a disabled cap does not query the database", async () => {
  const status = await localCapStatus(async () => { throw new Error("should not query"); }, 0);
  assert.deepEqual(status, { limit: 0, used: 0, capped: false });
});

// Integration test: needs a migrated PostgreSQL. Skipped when DATABASE_URL is not set.
const url = process.env.DATABASE_URL;

test("localCapStatus counts recent ollama runs only", { skip: !url && "DATABASE_URL not set" }, async () => {
  // Connect inside the test so an unreachable database cannot fail the pure tests in this file.
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query("BEGIN");
  try {
    const insert = (provider: string, status: string, startedMinutesAgo: number | null, createdMinutesAgo = startedMinutesAgo ?? 0) => db.query(
      `INSERT INTO agent_runs (provider,status,created_at,started_at)
       VALUES ($1,$2,NOW() - make_interval(mins => $4::int), CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - make_interval(mins => $3::int) END)`,
      [provider, status, startedMinutesAgo, createdMinutesAgo]);
    const run = async (sql: string) => (await db.query<{ count: string }>(sql)) as { rows: Array<{ count: string }> };
    const before = (await localCapStatus(run, 10)).used;

    await insert("ollama", "completed", 5);          // counts
    await insert("ollama", "running", 1);            // counts
    await insert("ollama", "failed", 30);            // counts: the model still did the work
    await insert("ollama", "completed", 61);         // too old
    await insert("ollama", "queued", 1);             // never started
    await insert("ollama", "awaiting_external", 1);  // not an execution
    await insert("codex-cli", "completed", 1);       // other provider
    await insert("ollama", "completed", null, 10);   // no started_at: falls back to created_at

    const status = await localCapStatus(run, before + 4);
    assert.equal(status.used, before + 4);
    assert.equal(status.capped, true);
    assert.equal((await localCapStatus(run, before + 5)).capped, false);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
});
