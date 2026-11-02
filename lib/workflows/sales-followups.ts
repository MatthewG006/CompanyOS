import { transaction } from "@/lib/db";
import { loadAgentMemory } from "@/lib/ai/memory";
import { buildTaskPrompt } from "@/lib/ai/router";

const manualProviders = new Set(["chatgpt-free", "claude-free", "codex"]);

export async function dispatchDueSalesFollowups() {
  return transaction(async (client) => {
    const due = await client.query<{ id: string; project_id: string; opportunity_title: string; follow_up_at: string }>(
      `SELECT l.id,l.project_id,l.opportunity_title,l.follow_up_at::text
       FROM sales_leads l
       WHERE l.stage IN ('new','qualified','proposal') AND l.follow_up_at IS NOT NULL AND l.follow_up_at<=NOW()
         AND NOT EXISTS (SELECT 1 FROM sales_followup_reminders r WHERE r.sales_lead_id=l.id AND r.scheduled_for=l.follow_up_at)
       ORDER BY l.follow_up_at LIMIT 20 FOR UPDATE OF l SKIP LOCKED`,
    );
    if (!due.rowCount) return 0;
    const sales = await client.query<{
      id: string;
      name: string;
      role: string | null;
      mission: string | null;
      description: string | null;
      provider: string;
      memory_scope: string[];
      allowed_actions: string[];
    }>("SELECT id,name,role,mission,description,provider,memory_scope,allowed_actions FROM agents WHERE LOWER(name)='sales' LIMIT 1");
    const salesAgent = sales.rows[0];

    let created = 0;
    for (const lead of due.rows) {
      const reminder = await client.query<{ id: string }>(
        `INSERT INTO sales_followup_reminders (sales_lead_id,scheduled_for)
         VALUES ($1,$2) ON CONFLICT (sales_lead_id,scheduled_for) DO UPDATE
           SET status='open',task_id=NULL,completed_at=NULL
           WHERE sales_followup_reminders.status IN ('superseded','cancelled')
         RETURNING id`,
        [lead.id, lead.follow_up_at],
      );
      if (!reminder.rows[0]) continue;
      const title = `Prepare an owner-reviewed follow-up for ${lead.opportunity_title}`.slice(0, 200);
      const task = await client.query<{ id: string }>(
        `INSERT INTO tasks (project_id,agent_id,title,priority,status,due_at)
         VALUES ($1,$2,$3,'normal','todo',$4) RETURNING id`,
        [lead.project_id, salesAgent?.id ?? null, title, lead.follow_up_at],
      );
      await client.query("UPDATE sales_followup_reminders SET task_id=$2 WHERE id=$1", [reminder.rows[0].id, task.rows[0].id]);
      let agentRunId: string | null = null;
      if (salesAgent) {
        const isManual = manualProviders.has(salesAgent.provider);
        const workflowContext = {
          category: "sales_followup",
          sales_lead_id: lead.id,
          opportunity_title: lead.opportunity_title,
        };

        if (isManual) {
          const baseMemory = await loadAgentMemory(lead.project_id, salesAgent.memory_scope, task.rows[0].id);
          const memory = {
            ...baseMemory,
            gmail_follow_up: workflowContext,
          };
          const prompt = buildTaskPrompt({
            title,
            priority: "normal",
            project_name: null,
            agent_name: salesAgent.name,
            agent_manager_name: null,
            agent_role: salesAgent.role,
            agent_mission: salesAgent.mission,
            agent_description: salesAgent.description,
            agent_memory_scope: salesAgent.memory_scope,
            agent_allowed_actions: salesAgent.allowed_actions,
          }, memory);
          const run = await client.query<{ id: string }>(
            `INSERT INTO agent_runs (agent_id,task_id,provider,model,status,summary,input)
             VALUES ($1,$2,$3,'manual handoff','awaiting_external','Prompt ready for manual provider handoff.',$4::jsonb) RETURNING id`,
            [salesAgent.id, task.rows[0].id, salesAgent.provider, JSON.stringify({
              source: "sales-followup-workflow",
              prompt,
              task: { title, priority: "normal" },
              memory,
              workflow_context: workflowContext,
              routing: { requested: salesAgent.provider, manual: salesAgent.provider },
            })],
          );
          agentRunId = run.rows[0].id;
        } else {
          const runProvider = salesAgent.provider === "agnostic" || !salesAgent.provider ? "codex-cli" : salesAgent.provider;
          const run = await client.query<{ id: string }>(
            `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,input)
             VALUES ($1,$2,$3,'queued','Queued by scheduled Sales follow-up.',$4::jsonb) RETURNING id`,
            [salesAgent.id, task.rows[0].id, runProvider, JSON.stringify({
              source: "sales-followup-workflow",
              workflow_context: workflowContext,
            })],
          );
          agentRunId = run.rows[0].id;
        }
      }
      await client.query(
        `INSERT INTO events (source,event_type,title,severity,project_id,payload)
         VALUES ('sales-pipeline','sales_followup_reminder_created','Sales follow-up reminder created','info',$1,$2::jsonb)`,
        [lead.project_id, JSON.stringify({ lead_id: lead.id, reminder_id: reminder.rows[0].id, task_id: task.rows[0].id, agent_run_id: agentRunId })],
      );
      created += 1;
    }
    return created;
  });
}
