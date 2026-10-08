import type { ProviderDefinition, ProviderId } from "./provider-registry";
import { providerSupportsTask } from "./provider-registry";
import type { TaskSpec } from "./task-spec";

/** Providers that bill the owner's API account per request. */
export const BILLABLE_PROVIDERS: readonly ProviderId[] = ["openai", "anthropic"];

export type DispatchPolicy = {
  requested: ProviderId | "auto";
  automaticOnly: boolean;
  allowBillable: boolean;
  codexAuthenticated: boolean;
  manualProvider?: ProviderId;
};

export type DispatchPlan = {
  automatic: ProviderId[];
  manual: ProviderId | null;
};

export type DispatchAttempt = { provider: ProviderId; error: string };

export class DispatchError extends Error {
  attempts: DispatchAttempt[];
  constructor(message: string, attempts: DispatchAttempt[]) {
    super(message);
    this.name = "DispatchError";
    this.attempts = attempts;
  }
}

function usable(provider: ProviderDefinition, policy: DispatchPolicy) {
  if (!provider.isConfigured()) return false;
  if (provider.id === "codex-cli" && !policy.codexAuthenticated) return false;
  return true;
}

export function planDispatch(policy: DispatchPolicy, providers: ProviderDefinition[], task?: TaskSpec): DispatchPlan {
  const byPriority = [...providers]
    .filter((provider) => !task || providerSupportsTask(provider, task))
    .sort((a, b) => {
      if (!task) return b.priority - a.priority;
      const preferred = task.execution.preferredProviders ?? [];
      const fallback = task.execution.fallbackProviders ?? [];
      const aIndex = [...preferred, ...fallback].indexOf(a.id);
      const bIndex = [...preferred, ...fallback].indexOf(b.id);
      const aScore = aIndex === -1 ? 0 : 1000 - aIndex * 10;
      const bScore = bIndex === -1 ? 0 : 1000 - bIndex * 10;
      return (bScore + b.priority) - (aScore + a.priority);
    });
  const manualProviders = byPriority.filter((provider) => provider.mode === "manual_handoff");

  if (policy.requested !== "auto") {
    const chosen = providers.find((provider) => provider.id === policy.requested);
    if (!chosen || (task && !providerSupportsTask(chosen, task))) return { automatic: [], manual: null };
    if (chosen.mode === "manual_handoff") return { automatic: [], manual: policy.automaticOnly ? null : chosen.id };
    return { automatic: usable(chosen, policy) ? [chosen.id] : [], manual: null };
  }

  const automatic = byPriority
    .filter((provider) => provider.mode !== "manual_handoff")
    .filter((provider) => usable(provider, policy))
    .filter((provider) => policy.allowBillable || !BILLABLE_PROVIDERS.includes(provider.id))
    .map((provider) => provider.id);

  let manual: ProviderId | null = null;
  if (!policy.automaticOnly) {
    const preferred = manualProviders.find((provider) => provider.id === policy.manualProvider);
    manual = (preferred ?? manualProviders[0])?.id ?? null;
  }
  return { automatic, manual };
}

export type DispatchRunner<T extends { model: string; text: string }> = (provider: ProviderId, prompt: string) => Promise<T>;

export async function executeWithFallback<T extends { model: string; text: string }>(
  automatic: ProviderId[],
  prompt: string,
  run: DispatchRunner<T>,
): Promise<T & { provider: ProviderId; attempts: DispatchAttempt[] }> {
  const attempts: DispatchAttempt[] = [];
  for (const provider of automatic) {
    try {
      const result = await run(provider, prompt);
      return { ...result, provider, attempts };
    } catch (error) {
      attempts.push({ provider, error: (error instanceof Error ? error.message : "Provider failed.").slice(0, 300) });
    }
  }
  const detail = attempts.length
    ? attempts.map((attempt) => `${attempt.provider}: ${attempt.error}`).join(" | ")
    : "No automatic AI provider is available.";
  throw new DispatchError(detail.slice(0, 400), attempts);
}
