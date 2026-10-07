import { runWithCodexCli, runWithProvider, type AgentProvider, type RoutedProvider } from "./router";
import { getProvider } from "./provider-registry";

export type ExecutionRequest = {
  provider: AgentProvider;
  prompt: string;
};

export type ExecutionResult = {
  provider: AgentProvider;
  model: string;
  text: string;
};

export async function executeAgent(request: ExecutionRequest): Promise<ExecutionResult> {
  const definition = getProvider(request.provider);
  if (!definition) throw new Error(`Unsupported AI provider: ${request.provider}`);

  const result = request.provider === "codex-cli"
    ? await runWithCodexCli(request.prompt)
    : request.provider === "openai" || request.provider === "anthropic" || request.provider === "ollama"
      ? await runWithProvider(request.provider as RoutedProvider, request.prompt)
      : null;

  if (!result) throw new Error(`${request.provider} requires a manual handoff; it cannot execute inside the server runtime.`);
  return { provider: request.provider, model: result.model, text: result.text };
}