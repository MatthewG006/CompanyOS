import { transaction } from "@/lib/db";

const WORKFLOW_KEY = "gmail_attention_to_agent_task_v1";
const categoryAgent: Record<string, string> = {
  sales: "Sales",
  support: "Support",
  billing: "Finance",
};

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

    const agentResult = await client.query<{ id: string }>(
      "SELECT id FROM agents WHERE LOWER(name)=LOWER($1) LIMIT 1",
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
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (project_id,agent_id,title,priority,status)
       VALUES ($1,$2,$3,$4,'todo') RETURNING id`,
      [attention.project_id, agent.id, title, attention.priority === "high" ? "high" : "normal"],
    );
    const task = taskResult.rows[0];
    const runResult = await client.query<{ id: string }>(
      `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,input)
       VALUES ($1,$2,'codex-cli','queued','Queued by Gmail business-attention workflow.',$3::jsonb)
       RETURNING id`,
      [agent.id, task.id, JSON.stringify({
        source: "gmail-workflow",
        attention_item_id: attention.id,
        workflow_context: {
          category,
          subject: (attention.email_subject ?? attention.title).slice(0, 300),
          snippet: (attention.email_snippet ?? "").slice(0, 700),
        },
      })],
    );
    const run = runResult.rows[0];

    await client.query(
      `UPDATE workflow_dispatches SET task_id=$2,agent_run_id=$3,status='queued' WHERE id=$1`,
      [dispatch.id, task.id, run.id],
    );
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('gmail-workflow','agent_task_queued',$1,'info',$2,$3::jsonb)`,
      [`${agentName} assigned a new Gmail follow-up`, attention.project_id, JSON.stringify({ workflow_key: WORKFLOW_KEY, attention_item_id: attention.id, task_id: task.id, agent_run_id: run.id })],
    );
    return true;
  });
}
