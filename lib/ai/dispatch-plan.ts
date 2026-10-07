import type { ProviderDefinition, ProviderId } from "./provider-registry";

/** Providers that bill the owner's API account per request. */
export const BILLABLE_PROVIDERS: readonly ProviderId[] = ["openai", "anthropic"];

export type DispatchPolicy = {
  /** A specific provider chosen by the owner, or "auto" to let CompanyOS pick. */
  requested: ProviderId | "auto";
  /** Queue/worker runs have nobody to paste a response, so manual handoff is never a fallback. */
  automaticOnly: boolean;
  /** Billable API providers join automatic routing only when the owner opts in. */
  allowBillable: boolean;
  /** Codex CLI is registered as always configured; its real sign-in state is checked at runtime. */
  codexAuthenticated: boolean;
  /** Which consumer chat service receives the prompt when no automatic provider can run. */
  manualProvider?: ProviderId;
};

export type DispatchPlan = {
  /** Providers CompanyOS can execute itself, in the order they will be tried. */
  automatic: ProviderId[];
  /** Provider the owner pastes a response from when nothing automatic ran; null if not allowed. */
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

export function planDispatch(policy: DispatchPolicy, providers: ProviderDefinition[]): DispatchPlan {
  const byPriority = [...providers].sort((a, b) => b.priority - a.priority);
  const manualProviders = byPriority.filter((provider) => provider.mode === "manual_handoff");

  if (policy.requested !== "auto") {
    const chosen = providers.find((provider) => provider.id === policy.requested);
    if (!chosen) return { automatic: [], manual: null };
    // An explicit choice never silently falls back to a different provider.
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

/** Tries each automatic provider in order and records why earlier ones failed. */
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
