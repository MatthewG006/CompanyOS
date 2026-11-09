import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// scripts/agent-worker.mjs is a standalone .mjs script, so it mirrors the
// SSL rule from lib/db-ssl.ts inline instead of importing it. Like
// tests/worker-db-guardrails.test.ts, these source assertions pin the
// parity so a future edit cannot silently reintroduce unverified TLS in
// the worker while the app verifies certificates (or vice versa).
async function readWorker() {
  return readFile(new URL("../scripts/agent-worker.mjs", import.meta.url), "utf8");
}

test("worker checks sslmode=no-verify before stripping sslmode from the URL", async () => {
  const worker = await readWorker();
  assert.ok(worker.includes("sslmode=no-verify"), "worker must look for the sslmode=no-verify opt-out");
  const noVerifyAt = worker.indexOf('dbUrl.includes("sslmode=no-verify")');
  const stripAt = worker.indexOf("dbUrl = dbUrl.replace");
  assert.ok(noVerifyAt >= 0 && stripAt > noVerifyAt, "the no-verify check must run before sslmode is stripped");
});

test("worker derives rejectUnauthorized from the no-verify opt-out", async () => {
  const worker = await readWorker();
  assert.ok(worker.includes("rejectUnauthorized = !sslNoVerify"), "rejectUnauthorized must be the negation of the no-verify flag");
  assert.ok(worker.includes("ssl: { rejectUnauthorized }"), "the pool must pass the derived rejectUnauthorized value");
});

test("worker never disables certificate verification unconditionally", async () => {
  const worker = await readWorker();
  assert.ok(!worker.includes("rejectUnauthorized: false"), "rejectUnauthorized: false must not appear in the worker");
});
