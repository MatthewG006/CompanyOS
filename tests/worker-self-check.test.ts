import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// The worker self-check exists so substrate drift (a Codex config the CLI
// rejects, a missing agent_runs column, a missing API key) is caught by
// the worker itself and surfaced as a system check, instead of ambushing
// the first real task (run 5fd29a5b, 2026-11-12). These guards pin the
// load-bearing pieces: the canary runs doctor with the exact isolation
// overrides, the heartbeat carries the result, the claim loop gates on
// it, the circuit breaker re-arms it, and the app renders it.
async function readRepoFile(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("worker self-check test-loads the Codex config with the isolation overrides", async () => {
  const worker = await readRepoFile("scripts/agent-worker.mjs");
  assert.ok(worker.includes("runWorkerSelfCheck"), "worker is missing runWorkerSelfCheck");
  assert.ok(
    worker.includes('[...CODEX_ISOLATION_CONFIG_ARGS, "doctor"]'),
    "the canary must run doctor with the worker's exact isolation overrides",
  );
  assert.ok(worker.includes("CODEX_CONFIG_ERROR_SIGNATURE"), "worker is missing the config-error signature");
  assert.ok(worker.includes("available_at"), "the schema spot-check must cover the claim column");
  assert.ok(worker.includes("openai_key_configured"), "the self-check must report key presence (never the key)");
});

test("worker heartbeat carries the self-check and degrades when it fails", async () => {
  const worker = await readRepoFile("scripts/agent-worker.mjs");
  for (const field of ["codex_config_ok", "codex_version", "worker_commit", "db_schema_ok", "self_check_ok"]) {
    assert.ok(worker.includes(field), `heartbeat/self-check is missing field: ${field}`);
  }
  assert.ok(
    worker.includes('workerSelfCheck.self_check_ok) ? "online" : "degraded"'),
    "heartbeat status must degrade while the self-check fails",
  );
});

test("worker claim loop gates on the self-check and the circuit breaker re-arms it", async () => {
  const worker = await readRepoFile("scripts/agent-worker.mjs");
  assert.ok(worker.includes("const mayClaim = !workerSelfCheck || workerSelfCheck.self_check_ok;"), "claim gate is missing");
  assert.ok(worker.includes("AND $1::boolean"), "the claim query must apply the gate");
  assert.ok(worker.includes("[mayClaim]"), "the claim query must receive the gate value");
  assert.ok(
    worker.includes("if (CODEX_CONFIG_ERROR_SIGNATURE.test(stderr)) codexConfigSuspect = true;"),
    "a config-load failure during a run must trip the circuit breaker",
  );
});

test("dashboard surfaces the worker self-check as the Codex:worker-health system check", async () => {
  const data = await readRepoFile("lib/data.ts");
  assert.ok(data.includes('"Codex:worker-health"'), "lib/data.ts is missing the worker-health system check");
  assert.ok(data.includes("runtime_heartbeats"), "the check must read the worker heartbeat");
  assert.ok(data.includes("codex_config_ok"), "the check must key off the self-check fields");
});
