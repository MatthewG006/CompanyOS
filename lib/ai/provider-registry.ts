import type { ExecutionMode, TaskCapabilities, TaskSpec } from "./task-spec";

export type ProviderId = "openai" | "anthropic" | "ollama" | "codex-cli" | "chatgpt-free" | "claude-free" | "codex";
export type ProviderDefinition = {
  id: ProviderId;
  mode: ExecutionMode;
  capabilities: TaskCapabilities;
  isConfigured: () => boolean;
  priority: number;
};

const definitions: ProviderDefinition[] = [
  { id: "codex-cli", mode: "cli", capabilities: { reasoning: true, coding: true, filesystem: true, shell: true }, isConfigured: () => true, priority: 100 },
  { id: "openai", mode: "api", capabilities: { reasoning: true, coding: true, web: true }, isConfigured: () => Boolean(process.env.OPENAI_API_KEY && process.env.AI_OPENAI_MODEL), priority: 80 },
  { id: "anthropic", mode: "api", capabilities: { reasoning: true, coding: true, web: true }, isConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY && process.env.AI_ANTHROPIC_MODEL), priority: 75 },
  { id: "ollama", mode: "local", capabilities: { reasoning: true, coding: true }, isConfigured: () => Boolean(process.env.OLLAMA_MODEL), priority: 70 },
  { id: "chatgpt-free", mode: "manual_handoff", capabilities: { reasoning: true, coding: true, web: true }, isConfigured: () => true, priority: 60 },
  { id: "claude-free", mode: "manual_handoff", capabilities: { reasoning: true, coding: true, web: true }, isConfigured: () => true, priority: 55 },
  { id: "codex", mode: "manual_handoff", capabilities: { reasoning: true, coding: true }, isConfigured: () => true, priority: 50 },
];

export function providerRegistry(): ProviderDefinition[] { return definitions.map((provider) => ({ ...provider, capabilities: { ...provider.capabilities } })); }
export function getProvider(id: string): ProviderDefinition | undefined { return definitions.find((provider) => provider.id === id); }

function supports(provider: ProviderDefinition, capabilities: TaskCapabilities) {
  return Object.entries(capabilities).every(([key, required]) => !required || provider.capabilities[key as keyof TaskCapabilities] === true);
}

export function routeTask(task: TaskSpec) {
  const preferred = task.execution.preferredProviders ?? [];
  const fallback = task.execution.fallbackProviders ?? [];
  const order = [...preferred, ...fallback];
  const candidates = providerRegistry()
    .filter((provider) => provider.isConfigured())
    .filter((provider) => supports(provider, task.capabilities))
    .filter((provider) => task.constraints.dataSensitivity !== "confidential" || provider.mode === "local" || provider.id === "codex-cli")
    .map((provider) => ({ provider, score: (order.indexOf(provider.id) === -1 ? 0 : 1000 - order.indexOf(provider.id) * 10) + provider.priority }))
    .sort((a, b) => b.score - a.score);
  return { selected: candidates[0]?.provider ?? null, fallbacks: candidates.slice(1).map((candidate) => candidate.provider) };
}