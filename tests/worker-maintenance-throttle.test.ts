import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// scripts/agent-worker.mjs is a standalone .mjs script with a top-level
// polling loop, so its maintenance throttle cannot be unit-tested by
// importing it. Like tests/worker-db-guardrails.test.ts, these source
// assertions pin the behaviour so a future edit cannot silently return
// to writing a heartbeat and running the lease-expiry sweep on every
// ~3s poll.
async function readWorker() {
  return readFile(new URL("../scripts/agent-worker.mjs", import.meta.url), "utf8");
}

test("database-mode maintenance is throttled to a 30 second interval", async () => {
  const worker = await readWorker();
  assert.ok(worker.includes("MAINTENANCE_INTERVAL_MS = 30_000"), "worker must define a 30s maintenance interval");
  assert.ok(worker.includes("let lastMaintenanceAt = 0;"), "lastMaintenanceAt must start at 0 so the first loop iteration runs maintenance immediately");
});

test("heartbeat and lease expiry sit behind the maintenance gate", async () => {
  const worker = await readWorker();
  const gate = "if (Date.now() - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS)";
  const gateAt = worker.indexOf(gate);
  assert.ok(gateAt >= 0, "the maintenance gate expression must guard the heartbeat and lease-expiry block");

  const loopAt = worker.indexOf("while (!stopping)");
  const heartbeatAt = worker.indexOf("INSERT INTO runtime_heartbeats");
  const leaseAt = worker.indexOf("Worker lease expired.");
  assert.ok(loopAt >= 0 && gateAt > loopAt, "the gate must appear inside the polling loop");
  assert.ok(heartbeatAt > gateAt, "the heartbeat insert must appear after the gate in source order");
  assert.ok(leaseAt > gateAt, "the lease-expiry sweep must appear after the gate in source order");

  const claimAt = worker.indexOf("// Claim next queued run");
  assert.ok(claimAt > gateAt, "run claiming must stay outside/after the maintenance block, on the normal poll interval");
});
