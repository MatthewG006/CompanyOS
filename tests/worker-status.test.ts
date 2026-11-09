import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKER_CODEX_TRUST_WINDOW_SECONDS, workerReportsCodexAvailable } from "../lib/ai/worker-status.ts";

// The worker heartbeat is a single self-reported row, so dispatch only
// trusts it inside a short freshness window and only while the worker
// reports status "online" with an authenticated Codex CLI.

test("trust window is 45 seconds", () => {
  assert.equal(WORKER_CODEX_TRUST_WINDOW_SECONDS, 45);
});

test("fresh online heartbeat with an authenticated Codex CLI is trusted", () => {
  assert.equal(
    workerReportsCodexAvailable({ status: "online", details: { codex_cli_authenticated: true }, age_seconds: 5 }),
    true,
  );
});

test("a heartbeat at exactly the trust-window boundary is trusted", () => {
  assert.equal(
    workerReportsCodexAvailable({ status: "online", details: { codex_cli_authenticated: true }, age_seconds: 45 }),
    true,
  );
});

test("a stale heartbeat is not trusted, even inside the old 3-minute window", () => {
  assert.equal(
    workerReportsCodexAvailable({ status: "online", details: { codex_cli_authenticated: true }, age_seconds: 120 }),
    false,
  );
});

test("a degraded worker is not trusted, however fresh the heartbeat", () => {
  assert.equal(
    workerReportsCodexAvailable({ status: "degraded", details: { codex_cli_authenticated: true }, age_seconds: 5 }),
    false,
  );
});

test("an unauthenticated or unreported Codex flag is not trusted", () => {
  assert.equal(
    workerReportsCodexAvailable({ status: "online", details: { codex_cli_authenticated: false }, age_seconds: 5 }),
    false,
  );
  assert.equal(workerReportsCodexAvailable({ status: "online", details: {}, age_seconds: 5 }), false);
  assert.equal(workerReportsCodexAvailable({ status: "online", details: null, age_seconds: 5 }), false);
});

test("a missing worker row is not trusted", () => {
  assert.equal(workerReportsCodexAvailable(null), false);
  assert.equal(workerReportsCodexAvailable(undefined), false);
});
