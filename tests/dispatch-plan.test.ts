import assert from "node:assert/strict";
import { test } from "node:test";
import { DispatchError, executeWithFallback, planDispatch, type DispatchPolicy } from "../lib/ai/dispatch-plan.ts";
import type { ProviderDefinition, ProviderId } from "../lib/ai/provider-registry.ts";

const def = (id: ProviderId, mode: ProviderDefinition["mode"], priority: number, configured = true, capabilities: ProviderDefinition["capabilities"] = { reasoning: true }): ProviderDefinition => ({
  id, mode, priority, capabilities, isConfigured: () => configured, maxDurationMs: mode === "cli" ? 120_000 : mode === "manual_handoff" ? 0 : 60_000,
});
// Mirrors the capabilities declared in lib/ai/provider-registry.ts.
const basic = { reasoning: true, coding: true };
const hosted = { reasoning: true, coding: true, web: true };
const providers = [
  def("codex-cli", "cli", 100, true, { reasoning: true, coding: true, filesystem: true, shell: true }),
  def("openai", "api", 80, true, hosted), def("anthropic", "api", 75, false, hosted), def("ollama", "local", 70, true, basic),
  def("chatgpt-free", "manual_handoff", 60, true, hosted), def("claude-free", "manual_handoff", 55, true, hosted), def("codex", "manual_handoff", 50, true, basic),
];
const base: DispatchPolicy = { requested: "auto", automaticOnly: false, allowBillable: false, codexAuthenticated: true };

test("auto routing skips billable providers unless the owner opts in", () => {
  assert.deepEqual(planDispatch(base, providers).automatic, ["codex-cli", "ollama"]);
  assert.deepEqual(planDispatch({ ...base, allowBillable: true }, providers).automatic, ["codex-cli", "openai", "ollama"]);
});

test("unsigned Codex CLI is skipped so a local model can run", () => {
  assert.deepEqual(planDispatch({ ...base, codexAuthenticated: false }, providers).automatic, ["ollama"]);
});

test("auto falls back to manual handoff only for interactive runs", () => {
  const none = providers.filter((p) => p.mode === "manual_handoff");
  assert.deepEqual(planDispatch(base, none), { automatic: [], manual: "chatgpt-free" });
  assert.deepEqual(planDispatch({ ...base, manualProvider: "claude-free" }, none), { automatic: [], manual: "claude-free" });
  assert.deepEqual(planDispatch({ ...base, automaticOnly: true }, none), { automatic: [], manual: null });
});

test("an explicit provider never falls back to another one", () => {
  assert.deepEqual(planDispatch({ ...base, requested: "openai" }, providers), { automatic: ["openai"], manual: null });
  assert.deepEqual(planDispatch({ ...base, requested: "anthropic" }, providers), { automatic: [], manual: null });
  assert.deepEqual(planDispatch({ ...base, requested: "claude-free" }, providers), { automatic: [], manual: "claude-free" });
  assert.deepEqual(planDispatch({ ...base, requested: "claude-free", automaticOnly: true }, providers), { automatic: [], manual: null });
});

test("executeWithFallback returns the first success and records earlier failures", async () => {
  const result = await executeWithFallback(["codex-cli", "ollama"], "p", async (provider) => {
    if (provider === "codex-cli") throw new Error("not signed in");
    return { model: "llama", text: "ok" };
  });
  assert.equal(result.provider, "ollama");
  assert.deepEqual(result.attempts, [{ provider: "codex-cli", error: "not signed in" }]);
});

test("executeWithFallback throws a DispatchError listing every failure", async () => {
  await assert.rejects(
    executeWithFallback(["codex-cli", "ollama"], "p", async (provider) => { throw new Error(`${provider} down`); }),
    (error: unknown) => error instanceof DispatchError && error.attempts.length === 2 && /ollama down/.test(error.message),
  );
  await assert.rejects(executeWithFallback([], "p", async () => ({ model: "m", text: "t" })), /No automatic AI provider/);
});

test("task requirements filter providers by capability and sensitivity", () => {
  const task = {
    taskId: "task",
    agentId: "agent",
    objective: "inspect infrastructure",
    capabilities: { coding: true, shell: true },
    constraints: { dataSensitivity: "confidential" as const },
    context: { memoryScopes: ["project"] },
    execution: { preferredProviders: ["codex-cli"], fallbackProviders: ["ollama"] },
  };
  assert.deepEqual(planDispatch(base, providers, task).automatic, ["codex-cli"]);
  assert.deepEqual(planDispatch({ ...base, codexAuthenticated: false }, providers, task).automatic, []);
});

test("task duration constraints reject providers whose execution ceiling is too long", () => {
  const task = {
    taskId: "task",
    agentId: "agent",
    objective: "fast task",
    capabilities: { reasoning: true },
    constraints: { maxDurationMs: 30_000 },
    context: { memoryScopes: [] },
    execution: {},
  };
  assert.deepEqual(planDispatch(base, providers, task).automatic, []);
});

test("task provider preferences influence automatic ordering", () => {
  const task = {
    taskId: "task",
    agentId: "agent",
    objective: "code",
    capabilities: { coding: true },
    constraints: {},
    context: { memoryScopes: [] },
    execution: { preferredProviders: ["ollama"] },
  };
  assert.deepEqual(planDispatch(base, providers, task).automatic, ["ollama", "codex-cli"]);
  assert.deepEqual(planDispatch(base, providers, { ...task, execution: {} }).automatic, ["codex-cli", "ollama"]);
});
