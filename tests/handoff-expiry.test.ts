import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { DEFAULT_HANDOFF_EXPIRY_HOURS, expireStaleHandoffs, handoffExpiryHours } from "../lib/ai/handoff-expiry.ts";

test("expiry hours default and clamp invalid input", () => {
  assert.equal(handoffExpiryHours(undefined), DEFAULT_HANDOFF_EXPIRY_HOURS);
  for (const bad of ["", "abc", "0", "-5", "1.5", "721"]) assert.equal(handoffExpiryHours(bad), DEFAULT_HANDOFF_EXPIRY_HOURS, bad);
  assert.equal(handoffExpiryHours("1"), 1);
  assert.equal(handoffExpiryHours("72"), 72);
  assert.equal(handoffExpiryHours("720"), 720);
});

// Integration test: needs a migrated PostgreSQL (npm run db:migrate). Skipped when DATABASE_URL is not set.
const url = process.env.DATABASE_URL;
let client: pg.Client | undefined;
before(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url });
  await client.connect();
});
after(async () => { await client?.end(); });

test("expireStaleHandoffs only expires old awaiting_external runs and audits each one", { skip: !url && "DATABASE_URL not set" }, async () => {
  assert.ok(client);
  const db: pg.Client = client;
  await db.query("BEGIN");
  try {
    const insert = async (status: string, ageHours: number) => (await db.query<{ id: string }>(
      `INSERT INTO agent_runs (provider,status,created_at) VALUES ('chatgpt-free',$1,NOW() - make_interval(hours => $2::int)) RETURNING id`, [status, ageHours])).rows[0].id;
    const stale = await insert("awaiting_external", 49);
    const fresh = await insert("awaiting_external", 47);
    const done = await insert("completed", 100);
    const queued = await insert("queued", 100);

    assert.equal(await expireStaleHandoffs(db, 48), 1);
    const states = Object.fromEntries((await db.query<{ id: string; status: string; error: string | null }>("SELECT id,status,error FROM agent_runs WHERE id=ANY($1)", [[stale, fresh, done, queued]])).rows.map((r) => [r.id, r]));
    assert.equal(states[stale].status, "expired");
    assert.match(states[stale].error ?? "", /within 48 hours/);
    assert.equal(states[fresh].status, "awaiting_external");
    assert.equal(states[done].status, "completed");
    assert.equal(states[queued].status, "queued");

    const events = await db.query("SELECT payload FROM events WHERE event_type='agent_run_expired' AND payload->>'run_id'=$1", [stale]);
    assert.equal(events.rowCount, 1);
    assert.equal(await expireStaleHandoffs(db, 48), 0); // idempotent

    // The paste-back guard (status='awaiting_external') now rejects a late response.
    const late = await db.query("UPDATE agent_runs SET status='completed' WHERE id=$1 AND status='awaiting_external' RETURNING id", [stale]);
    assert.equal(late.rowCount, 0);
  } finally {
    await db.query("ROLLBACK");
  }
});
