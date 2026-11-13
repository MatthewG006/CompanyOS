import type { PoolClient } from "pg";
import { buildTaskPrompt, type AgentMemory } from "@/lib/ai/router";
import { loadWordPressRunContext } from "@/lib/ai/wordpress-context";

/**
 * Codex CLI is the autonomous operator for every role: when a task is
 * created for an agent — by owner approval of an agent proposal, by an
 * owner command, or by a workflow — its execution run is queued here and
 * the agent worker claims it without any manual dispatch step.
 *
 * The one exception is a role explicitly configured for a manual handoff
 * provider (ChatGPT Free, Claude Free, or manual Codex): those runs wait
 * in `awaiting_external` with a prepared prompt, because consumer
 * subscriptions are owner-mediated and are not API credentials.
 */
const MANUAL_PROVIDERS = ["chatgpt-free", "claude-free", "codex"];

type AgentRow = {
  id: string;
  name: string;
  role: string | null;
  mission: string | null;
  description: string | null;
  provider: string;
  memory_scope: string[];
  allowed_actions: string[];
};

export async function queueTaskExecution(
  client: PoolClient,
  args: {
    projectId: string | null;
    agentId: string;
    taskId: string;
    title: string;
    priority: "low" | "normal" | "high" | "critical";
    source: string;
    inputExtras?: Record<string, unknown>;
  },
): Promise<{ provider: string; status: string } | null> {
  const agentResult = await client.query<AgentRow>(
    "SELECT id,name,role,mission,description,provider,memory_scope,allowed_actions FROM agents WHERE id=$1",
    [args.agentId],
  );
  const agent = agentResult.rows[0];
  if (!agent) return null;

  const isManual = MANUAL_PROVIDERS.includes(agent.provider);
  const provider = isManual ? agent.provider : "codex-cli";
  const status = isManual ? "awaiting_external" : "queued";
  const model = isManual ? "manual handoff" : null;
  const summary = isManual ? "Prompt ready for manual provider handoff." : "Queued for Codex CLI execution.";
  // Every run carries the full task prompt, not just manual handoffs: the
  // DB worker prefers input.prompt, and without it the run falls back to a
  // bare title-only prompt that never names the agent's permitted proposal
  // types — agents then improvise with tools the sandbox forbids (e.g. the
  // built-in image tool, which dies on approval_policy="never") instead of
  // proposing the matching CompanyOS tool.
  // Agents holding WordPress site-management permission get the site's
  // page index — and the current content of any page the task names —
  // as bounded run memory, so a fix task edits the real page instead of
  // declining or replacing blind. The loader never fails the queue.
  let memory: AgentMemory = {};
  if (agent.allowed_actions.includes("request_wordpress_manage")) {
    const wordpress = await loadWordPressRunContext(args.title);
    if (wordpress) memory = { wordpress };
  }
  const prompt = buildTaskPrompt(
    {
      title: args.title,
      priority: args.priority,
      project_name: null,
      agent_name: agent.name,
      agent_manager_name: null,
      agent_role: agent.role,
      agent_mission: agent.mission,
      agent_description: agent.description,
      agent_memory_scope: agent.memory_scope,
      agent_allowed_actions: agent.allowed_actions,
    },
    memory,
  );
  const input = isManual
    ? {
        source: args.source,
        ...args.inputExtras,
        prompt,
        routing: { requested: agent.provider, manual: agent.provider },
      }
    : { source: args.source, ...args.inputExtras, prompt };

  await client.query(
    `INSERT INTO agent_runs (agent_id,task_id,provider,model,status,summary,input)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [args.agentId, args.taskId, provider, model, status, summary, JSON.stringify(input)],
  );
  await client.query(
    `INSERT INTO events (project_id,source,event_type,title,severity,payload)
     VALUES ($1,'agent-router','agent_run_queued',$2,'info',$3::jsonb)`,
    [
      args.projectId,
      isManual ? `Task handed off to ${provider} for ${args.title}` : `Task queued for Codex CLI: ${args.title}`,
      JSON.stringify({ task_id: args.taskId, agent_id: args.agentId, provider, source: args.source }),
    ],
  );
  return { provider, status };
}
