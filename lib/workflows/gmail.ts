import { transaction } from "@/lib/db";
import { loadAgentMemory } from "@/lib/ai/memory";
import { buildTaskPrompt } from "@/lib/ai/router";

const WORKFLOW_KEY = "gmail_attention_to_agent_task_v1";
const categoryAgent: Record<string, string> = {
  sales: "Sales",
  support: "Support",
  billing: "Finance",
};
const manualProviders = new Set(["chatgpt-free", "claude-free", "codex"]);

export async function dispatchGmailAttention(attentionItemId: string, category: string) {
  const agentName = categoryAgent[category];
  if (!agentName) return false;

  return transaction(async (client) => {
    const attentionResult = await client.query<{
      id: string;
      project_id: string | null;
      title: string;
      priority: string;
      email_subject: string | null;
      email_snippet: string | null;
    }>(
      `SELECT ai.id,ai.project_id,ai.title,ai.priority,
              er.payload->>'subject' AS email_subject,er.payload->>'snippet' AS email_snippet
       FROM attention_items ai JOIN external_records er ON er.id=ai.external_record_id
       WHERE ai.id=$1 AND ai.source='google-gmail' AND ai.attention_type='email_follow_up' FOR UPDATE OF ai`,
      [attentionItemId],
    );
    const attention = attentionResult.rows[0];
    if (!attention?.project_id) return false;

    const agentResult = await client.query<{
      id: string;
      name: string;
      role: string | null;
      mission: string | null;
      description: string | null;
      provider: string;
      memory_scope: string[];
      allowed_actions: string[];
    }>(
      "SELECT id,name,role,mission,description,provider,memory_scope,allowed_actions FROM agents WHERE LOWER(name)=LOWER($1) LIMIT 1",
      [agentName],
    );
    const agent = agentResult.rows[0];
    if (!agent) return false;

    const dispatchResult = await client.query<{ id: string }>(
      `INSERT INTO workflow_dispatches (workflow_key,attention_item_id,project_id,agent_id,status)
       VALUES ($1,$2,$3,$4,'processing')
       ON CONFLICT (attention_item_id,workflow_key) DO NOTHING
       RETURNING id`,
      [WORKFLOW_KEY, attention.id, attention.project_id, agent.id],
    );
    const dispatch = dispatchResult.rows[0];
    if (!dispatch) return false;

    const title = `Review new ${category} Gmail message`;
    const priority = attention.priority === "high" ? "high" : "normal";
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (project_id,agent_id,title,priority,status)
       VALUES ($1,$2,$3,$4,'todo') RETURNING id`,
      [attention.project_id, agent.id, title, priority],
    );
    const task = taskResult.rows[0];

    const isManual = manualProviders.has(agent.provider);
    const workflowContext = {
      category,
      subject: (attention.email_subject ?? attention.title).slice(0, 300),
      snippet: (attention.email_snippet ?? "").slice(0, 700),
    };

    let runId: string;
    if (isManual) {
      const baseMemory = await loadAgentMemory(attention.project_id, agent.memory_scope, task.id);
      const memory = {
        ...baseMemory,
        gmail_follow_up: workflowContext,
      };
      const prompt = buildTaskPrompt({
        title,
        priority,
        project_name: null,
        agent_name: agent.name,
        agent_manager_name: null,
        agent_role: agent.role,
        agent_mission: agent.mission,
        agent_description: agent.description,
        agent_memory_scope: agent.memory_scope,
        agent_allowed_actions: agent.allowed_actions,
      }, memory);
      const runResult = await client.query<{ id: string }>(
        `INSERT INTO agent_runs (agent_id,task_id,provider,model,status,summary,input)
         VALUES ($1,$2,$3,'manual handoff','awaiting_external','Prompt ready for manual provider handoff.',$4::jsonb)
         RETURNING id`,
        [agent.id, task.id, agent.provider, JSON.stringify({
          source: "gmail-workflow",
          attention_item_id: attention.id,
          prompt,
          task: { title, priority },
          memory,
          workflow_context: workflowContext,
          routing: { requested: agent.provider, manual: agent.provider },
        })],
      );
      runId = runResult.rows[0].id;
    } else {
      const runProvider = agent.provider === "agnostic" || !agent.provider ? "codex-cli" : agent.provider;
      const runResult = await client.query<{ id: string }>(
        `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,input)
         VALUES ($1,$2,$3,'queued','Queued by Gmail business-attention workflow.',$4::jsonb)
         RETURNING id`,
        [agent.id, task.id, runProvider, JSON.stringify({
          source: "gmail-workflow",
          attention_item_id: attention.id,
          workflow_context: workflowContext,
        })],
      );
      runId = runResult.rows[0].id;
    }

    const dispatchStatus = isManual ? "awaiting_external" : "queued";
    await client.query(
      `UPDATE workflow_dispatches SET task_id=$2,agent_run_id=$3,status=$4 WHERE id=$1`,
      [dispatch.id, task.id, runId, dispatchStatus],
    );
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('gmail-workflow',$1,$2,'info',$3,$4::jsonb)`,
      [
        isManual ? "agent_run_queued" : "agent_task_queued",
        isManual ? `${agentName} Gmail follow-up handed off to ${agent.provider}` : `${agentName} assigned a new Gmail follow-up`,
        attention.project_id,
        JSON.stringify({ workflow_key: WORKFLOW_KEY, attention_item_id: attention.id, task_id: task.id, agent_run_id: runId, provider: isManual ? agent.provider : "codex-cli" }),
      ],
    );
    return true;
  });
}
