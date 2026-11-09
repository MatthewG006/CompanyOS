import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// scripts/agent-worker.mjs is a standalone .mjs script with a top-level
// polling loop, so its guardrails cannot be unit-tested by importing it.
// Like tests/worker-codex-isolation.test.ts, these source assertions pin
// the behaviours the review of PRs #10–#16 required, so a future edit
// cannot silently drop one.
async function readWorker() {
  return readFile(new URL("../scripts/agent-worker.mjs", import.meta.url), "utf8");
}

test("database mode is opt-in via COMPANYOS_WORKER_MODE=db, never DATABASE_URL alone", async () => {
  const worker = await readWorker();
  assert.ok(worker.includes("COMPANYOS_WORKER_MODE"), "worker must read COMPANYOS_WORKER_MODE");
  assert.ok(worker.includes('requestedWorkerMode === "db"'), "worker must compare the requested mode to \"db\"");
  assert.ok(worker.includes("useDatabaseMode"), "worker must gate DB mode on a useDatabaseMode flag");
  assert.ok(worker.includes("if (useDatabaseMode)"), "the DB branch must be gated on useDatabaseMode");
  assert.ok(
    !worker.includes("if (process.env.DATABASE_URL)"),
    "DATABASE_URL presence alone must not select database mode",
  );
  assert.ok(
    worker.includes("COMPANYOS_WORKER_MODE=db requires DATABASE_URL"),
    "requesting db mode without DATABASE_URL must log a clear error",
  );
});

test("worker never re-grants agent permissions at runtime", async () => {
  const worker = await readWorker();
  assert.ok(
    !worker.includes("UPDATE agents SET allowed_actions"),
    "the per-poll request_wordpress_publish re-grant must stay removed; grants belong in db/schema.sql and scripts/seed.mjs",
  );
});

test("database-mode WordPress approvals check the agent permission and bound the payload", async () => {
  const worker = await readWorker();
  assert.ok(
    worker.includes('task.agent_allowed_actions.includes("request_wordpress_publish")'),
    "WordPress approvals must only be inserted when the agent holds request_wordpress_publish",
  );
  assert.ok(worker.includes("boundedText(prop.title, 200)"), "proposal title must be bounded to 200 characters");
  assert.ok(worker.includes("boundedText(prop.reason, 500)"), "proposal reason must be bounded to 500 characters");
  assert.ok(worker.includes(".slice(0, 50_000)"), "proposal content must be bounded to 50,000 characters");
  assert.ok(
    worker.includes("JSON.stringify({ title, content })"),
    "approval payload must be exactly { title, content }, matching the server tool registry",
  );
});

test("database mode expires stale running runs on the worker lease", async () => {
  const worker = await readWorker();
  assert.ok(worker.includes("summary='Worker running on VM.'"), "lease expiry must scope to DB-mode runs");
  assert.ok(worker.includes("INTERVAL '5 minutes'"), "lease expiry must use the same five-minute lease as the HTTP worker");
  assert.ok(worker.includes("error='Worker lease expired.'"), "expired runs must record the lease-expired error");
  assert.ok(worker.includes("summary='Worker lease expired.'"), "expired runs must record the lease-expired summary");
  assert.ok(
    worker.includes("UPDATE workflow_dispatches SET status='failed' WHERE agent_run_id IN (SELECT id FROM expired)"),
    "expiry must also fail the linked workflow dispatches",
  );
});
