import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Codex-as-operator guards: approval (or owner creation) is the starting
// gun. Tasks created for an agent queue their execution run automatically
// through one shared helper, and the AI Workforce console is a live view
// of that queue — not a manual dispatch desk.

const read = (path: string) => readFileSync(path, "utf8");

test("the shared queue helper makes Codex CLI the default operator", () => {
  const helper = read("lib/ai/queue-task-run.ts");
  assert.match(helper, /export async function queueTaskExecution\(/, "queue helper must exist");
  assert.match(helper, /"codex-cli"/, "non-manual roles must execute via Codex CLI");
  assert.match(helper, /MANUAL_PROVIDERS = \["chatgpt-free", "claude-free", "codex"\]/, "manual handoff providers must stay owner-mediated");
  assert.match(helper, /awaiting_external/, "manual-provider runs must wait for the owner handoff");
  assert.match(helper, /INSERT INTO agent_runs/, "the helper must insert the run");
  assert.match(helper, /agent_run_queued/, "the helper must record the queue event");
});

test("approved and owner-created tasks queue execution automatically", () => {
  const registry = read("lib/ai/tool-registry.ts");
  assert.match(registry, /source: "owner_approved_task"/, "an approved create_task proposal must queue its task");
  assert.match(registry, /source: "owner_approved_delegation"/, "an approved delegation must queue via the same helper");
  assert.ok((registry.match(/queueTaskExecution\(client, \{/g) ?? []).length >= 2, "both task-creating tools must use the helper");

  const command = read("app/api/command/route.ts");
  assert.match(command, /queueTaskExecution/, "owner command-bar tasks must queue automatically");
  assert.match(command, /source: "owner_command"/, "command tasks must record their queue source");
  assert.match(command, /queued for autonomous execution by the Codex CLI worker/, "the owner must be told the task will just run");

  const tasks = read("app/api/tasks/route.ts");
  assert.match(tasks, /queueTaskExecution/, "API-created tasks with an agent must queue automatically");
  assert.match(tasks, /source: "api_task_created"/, "API tasks must record their queue source");

  const leads = read("app/api/sales/leads/route.ts");
  assert.match(leads, /startOnboardingForWonLead\(client, lead\)/, "won leads must start onboarding through the shared helper");
  const onboarding = read("lib/sales/onboarding.ts");
  assert.match(onboarding, /queueTaskExecution/, "onboarding step tasks must queue for the Support agent");
  assert.match(onboarding, /source: "customer_onboarding"/, "onboarding tasks must record their queue source");
});

test("the worker claims Codex CLI runs without any manual step", () => {
  const worker = read("app/api/agent-runs/worker/route.ts");
  assert.match(worker, /provider IN \('codex-cli', 'ollama', 'auto', 'agnostic'\)/, "the worker claim query must include codex-cli runs");
});

test("the console is a live queue view, not a dispatch desk", () => {
  const console_ = read("app/agents/AgentConsole.tsx");
  assert.doesNotMatch(console_, /Dispatch a task/, "the dispatch form must be gone");
  assert.doesNotMatch(console_, /Select & dispatch/, "per-task dispatch buttons must be gone");
  assert.doesNotMatch(console_, /Run next queued task/, "the manual run-next button must be gone");
  assert.doesNotMatch(console_, /Execution provider/, "the provider selector must be gone");
  assert.doesNotMatch(console_, /startRun|runNextQueued|selectTaskAndDispatch/, "dispatch handlers must be gone");
  assert.match(console_, /No dispatch step/, "the page must explain that work starts automatically");
  // The audit trail and the manual-handoff completion path remain.
  assert.match(console_, /Agent execution queue & history/, "run history must remain visible");
  assert.match(console_, /Resume handoff/, "awaiting handoffs must remain completable");
  assert.match(console_, /Retry in queue/, "failed runs must remain retryable");
});
