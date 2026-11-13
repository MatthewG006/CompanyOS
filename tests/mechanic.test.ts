import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// The mechanic is the second layer of the repair design: a different
// engine (Llama on the RAG host) diagnoses worker-health failures the
// Codex worker cannot diagnose itself, and may only ever *propose* one
// of three allowlisted runtime repairs — restart, update, rollback —
// which execute on the worker itself, through an owner approval, never
// through Codex. These guards pin the allowlist and every validation
// layer, the claim-gate exemption that lets a repair run be claimed
// while the worker is unhealthy, and the diagnosis plumbing.
async function readRepoFile(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("registry holds the repair_worker tool behind the DevOps-only permission", async () => {
  const registry = await readRepoFile("lib/ai/tool-registry.ts");
  assert.ok(registry.includes('actionType: "repair_worker"'), "registry is missing the repair_worker tool");
  assert.ok(registry.includes('permission: "request_worker_repair"'), "repair_worker must require request_worker_repair");
  assert.ok(registry.includes("[repairWorkerTool.actionType, repairWorkerTool]"), "repair_worker must be registered");
  for (const action of ["restart_worker", "update_worker", "rollback_worker"]) {
    assert.ok(registry.includes(`"${action}"`), `repair allowlist is missing ${action}`);
  }
  assert.ok(
    registry.includes("owner_approved_worker_repair"),
    "approving a repair must queue the worker execution like other worker-executed tools",
  );
  assert.ok(
    registry.includes("worker_repair: {"),
    "the queued run must carry the worker_repair spec the worker reads",
  );
});

test("repair execution re-validates the allowlist and the rollback commit", async () => {
  const registry = await readRepoFile("lib/ai/tool-registry.ts");
  assert.ok(
    registry.includes('throw new Error("The approved worker repair payload is invalid.")'),
    "execution must refuse payloads outside the allowlist",
  );
  assert.ok(
    registry.includes('throw new Error("The approved worker rollback payload is invalid.")'),
    "execution must refuse a rollback without a well-formed commit",
  );
  assert.ok(registry.includes("/^[0-9a-f]{7,40}$/"), "the commit pattern must bound rollback targets to hex hashes");
});

test("only the DevOps agent can propose repairs, in every proposal path", async () => {
  const router = await readRepoFile("lib/ai/router.ts");
  assert.ok(
    router.includes('includes("request_worker_repair") && task.agent_name?.toLowerCase() === "devops" ? ["repair_worker"]'),
    "the router must offer repair_worker only to DevOps holding the permission",
  );
  const actions = await readRepoFile("lib/ai/actions.ts");
  assert.ok(
    actions.includes('tool.actionType === "repair_worker" && run.agent_name?.toLowerCase() !== "devops"'),
    "server-side proposal recording must gate repair_worker to DevOps",
  );
  const agentsRoute = await readRepoFile("app/api/agents/route.ts");
  assert.ok(agentsRoute.includes('"request_worker_repair"'), "the agents API allow-list must include request_worker_repair");
  const schema = await readRepoFile("db/schema.sql");
  assert.ok(
    schema.includes(`'["request_worker_repair"]'::jsonb`),
    "schema must carry the idempotent DevOps grant for request_worker_repair",
  );
  const worker = await readRepoFile("scripts/agent-worker.mjs");
  assert.ok(worker.includes('includes("request_worker_repair")'), "the worker mirror must check request_worker_repair");
  assert.ok(worker.includes("canRepairWorker"), "the worker mirror must gate repair proposals to DevOps");
});

test("worker executes repairs itself, exempt from the self-check claim gate", async () => {
  const worker = await readRepoFile("scripts/agent-worker.mjs");
  assert.ok(
    worker.includes("(input->'worker_repair') IS NOT NULL"),
    "repair runs must be claimable while the self-check fails — they are the fix",
  );
  assert.ok(worker.includes("parseWorkerRepairSpec"), "worker is missing the repair spec parser");
  assert.ok(worker.includes("executeWorkerRepairRun"), "worker is missing the repair executor");
  assert.ok(worker.includes('"merge-base", "--is-ancestor"'), "rollback targets must be ancestors of origin/main");
  assert.ok(worker.includes('"merge", "--ff-only", "origin/main"'), "updates must fast-forward only");
  assert.ok(worker.includes("scheduleWorkerRestart"), "repairs that change code must restart the worker via its supervisor");
  assert.ok(worker.includes("last_good_commit"), "the heartbeat must carry the last known-good commit for rollback proposals");
});

test("mechanic diagnosis is validated and becomes an approval, never an execution", async () => {
  const mechanic = await readRepoFile("lib/integrations/mechanic.ts");
  assert.ok(mechanic.includes("/diagnose/jobs"), "the mechanic client must use the diagnosis job endpoints");
  assert.ok(mechanic.includes("validateDiagnosis"), "diagnoses must be re-validated at the app boundary");
  assert.ok(mechanic.includes("gatherWorkerHealthEvidence"), "the mechanic must gather heartbeat + failed-run evidence");
  assert.ok(mechanic.includes("runtime_heartbeats"), "evidence must include the worker heartbeat");
  assert.ok(mechanic.includes("createMechanicRepairApproval"), "a recommended repair must become an owner approval");
  assert.ok(mechanic.includes("payload->>'diagnosis_job_id'"), "approval creation must be idempotent per diagnosis job");
  assert.ok(mechanic.includes("LOWER(name)='devops'"), "mechanic approvals must be requested for the DevOps agent");

  const route = await readRepoFile("app/api/mechanic/route.ts");
  assert.ok(route.includes("x-companyos-owner-authenticated"), "the mechanic route must be owner-gated");
  assert.ok(route.includes("startMechanicDiagnosisJob"), "POST must start a diagnosis job");
  assert.ok(route.includes("createMechanicRepairApproval"), "GET completion must record the repair approval");

  const overview = await readRepoFile("components/LiveOverview.tsx");
  assert.ok(overview.includes("<MechanicPanel />"), "the Overview must mount the mechanic panel");
});
