import { transaction } from "@/lib/db";

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
    const sales = await client.query<{ id: string }>("SELECT id FROM agents WHERE LOWER(name)='sales' LIMIT 1");
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
      const task = await client.query<{ id: string }>(
        `INSERT INTO tasks (project_id,agent_id,title,priority,status,due_at)
         VALUES ($1,$2,$3,'normal','todo',$4) RETURNING id`,
        [lead.project_id, sales.rows[0]?.id ?? null, `Prepare an owner-reviewed follow-up for ${lead.opportunity_title}`.slice(0, 200), lead.follow_up_at],
      );
      await client.query("UPDATE sales_followup_reminders SET task_id=$2 WHERE id=$1", [reminder.rows[0].id, task.rows[0].id]);
      let agentRunId: string | null = null;
      if (sales.rows[0]) {
        const run = await client.query<{ id: string }>(
          `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,input)
           VALUES ($1,$2,'codex-cli','queued','Queued by scheduled Sales follow-up.',$3::jsonb) RETURNING id`,
          [sales.rows[0].id, task.rows[0].id, JSON.stringify({ source: "sales-followup-workflow", workflow_context: {
            category: "sales_followup", sales_lead_id: lead.id, opportunity_title: lead.opportunity_title,
          } })],
        );
        agentRunId = run.rows[0].id;
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
