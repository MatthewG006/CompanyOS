export type ExecutionMode = "api" | "cli" | "manual_handoff" | "local";
export type DataSensitivity = "public" | "internal" | "confidential";
export type TaskCapabilities = {
  reasoning?: boolean;
  coding?: boolean;
  web?: boolean;
  filesystem?: boolean;
  shell?: boolean;
  email?: boolean;
};
export type TaskConstraints = {
  maxCostCents?: number;
  maxDurationMs?: number;
  requiresApproval?: boolean;
  dataSensitivity?: DataSensitivity;
};
export type TaskSpec = {
  taskId: string;
  agentId: string;
  objective: string;
  capabilities: TaskCapabilities;
  constraints: TaskConstraints;
  context: { projectId?: string; memoryScopes: string[] };
  execution: { preferredProviders?: string[]; fallbackProviders?: string[] };
};
export type ExecutionPacket = {
  executionId: string;
  task: TaskSpec;
  agent: { id: string; name: string; role: string };
  project?: string | null;
  context: Record<string, unknown>;
  capabilities: TaskCapabilities;
  constraints: TaskConstraints;
  approval: { requiredForExternalActions: boolean };
  outputSchema: { type: "agent_result" };
};

const capabilityKeys: readonly (keyof TaskCapabilities)[] = ["reasoning", "coding", "web", "filesystem", "shell", "email"];
const sensitivityValues: readonly DataSensitivity[] = ["public", "internal", "confidential"];

export function normalizeTaskCapabilities(value: unknown): TaskCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reasoning: true };
  const source = value as Record<string, unknown>;
  const result: TaskCapabilities = {};
  for (const key of capabilityKeys) {
    if (source[key] === true) result[key] = true;
  }
  return Object.keys(result).length ? result : { reasoning: true };
}

export function normalizeTaskConstraints(value: unknown): TaskConstraints {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { dataSensitivity: "internal" };
  const source = value as Record<string, unknown>;
  const result: TaskConstraints = { dataSensitivity: "internal" };
  if (Number.isSafeInteger(source.maxCostCents) && Number(source.maxCostCents) >= 0) result.maxCostCents = Number(source.maxCostCents);
  if (Number.isSafeInteger(source.maxDurationMs) && Number(source.maxDurationMs) > 0) result.maxDurationMs = Number(source.maxDurationMs);
  if (typeof source.requiresApproval === "boolean") result.requiresApproval = source.requiresApproval;
  if (sensitivityValues.includes(source.dataSensitivity as DataSensitivity)) result.dataSensitivity = source.dataSensitivity as DataSensitivity;
  return result;
}

export function normalizeProviderList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((provider): provider is string => typeof provider === "string" && provider.length > 0).slice(0, 8);
}
