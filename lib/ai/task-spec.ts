export type ExecutionMode = "api" | "cli" | "manual_handoff" | "local";
export type DataSensitivity = "public" | "internal" | "confidential";
export type TaskCapabilities = { reasoning?: boolean; coding?: boolean; web?: boolean; filesystem?: boolean; shell?: boolean; email?: boolean; };
export type TaskConstraints = { maxCostCents?: number; maxDurationMs?: number; requiresApproval?: boolean; dataSensitivity?: DataSensitivity; };
export type TaskSpec = {
  taskId: string; agentId: string; objective: string; capabilities: TaskCapabilities; constraints: TaskConstraints;
  context: { projectId?: string; memoryScopes: string[] };
  execution: { preferredProviders?: string[]; fallbackProviders?: string[] };
};
export type ExecutionPacket = {
  executionId: string; task: TaskSpec; agent: { id: string; name: string; role: string };
  project?: string | null; context: Record<string, unknown>; capabilities: TaskCapabilities; constraints: TaskConstraints;
  approval: { requiredForExternalActions: boolean }; outputSchema: { type: "agent_result" };
};