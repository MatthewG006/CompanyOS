import assert from "node:assert/strict";
import { test } from "node:test";
import { DispatchError, executeWithFallback, planDispatch, type DispatchPolicy } from "../lib/ai/dispatch-plan.ts";
import type { ProviderDefinition, ProviderId } from "../lib/ai/provider-registry.ts";

const def = (id: ProviderId, mode: ProviderDefinition["mode"], priority: number, configured = true): ProviderDefinition => ({
  id, mode, priority, capabilities: { reasoning: true }, isConfigured: () => configured,
});
const providers = [
  def("codex-cli", "cli", 100), def("openai", "api", 80), def("anthropic", "api", 75, false), def("ollama", "local", 70),
  def("chatgpt-free", "manual_handoff", 60), def("claude-free", "manual_handoff", 55), def("codex", "manual_handoff", 50),
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
