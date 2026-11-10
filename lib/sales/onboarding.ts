import type { PoolClient } from "pg";
import { queueTaskExecution } from "@/lib/ai/queue-task-run";

export const onboardingChecklist = [
  "Confirm customer requirements and primary contact",
  "Review project setup and required access",
  "Prepare welcome and getting-started materials for owner review",
  "Verify initial customer access and service readiness",
  "Schedule kickoff and capture next steps",
];

/**
 * Start customer onboarding for a won lead: one onboarding record, one
 * Support task per checklist step, each queued for autonomous execution.
 * Idempotent per lead (ON CONFLICT DO NOTHING on the onboarding record).
 * Shared by the pipeline PATCH and the lead-outcomes endpoint so a "Won"
 * outcome behaves identically however it is recorded.
 */
export async function startOnboardingForWonLead(
  client: PoolClient,
  lead: { id: string; project_id: string; opportunity_title: string },
): Promise<boolean> {
  const source = await client.query<{ contact_id: string }>("SELECT contact_id FROM sales_leads WHERE id=$1", [lead.id]);
  if (!source.rows[0]) return false;
  const onboarding = await client.query<{ id: string }>(
    `INSERT INTO customer_onboardings (sales_lead_id,project_id,contact_id)
     VALUES ($1,$2,$3) ON CONFLICT (sales_lead_id) DO NOTHING RETURNING id`,
    [lead.id, lead.project_id, source.rows[0].contact_id],
  );
  if (!onboarding.rows[0]) return false;
  const support = await client.query<{ id: string }>("SELECT id FROM agents WHERE LOWER(name)='support' LIMIT 1");
  for (const [index, stepTitle] of onboardingChecklist.entries()) {
    const task = await client.query<{ id: string }>(
      `INSERT INTO tasks (project_id,agent_id,title,priority,status)
       VALUES ($1,$2,$3,'normal','todo') RETURNING id`,
      [lead.project_id, support.rows[0]?.id ?? null, `Customer onboarding: ${stepTitle}`],
    );
    await client.query(
      `INSERT INTO onboarding_steps (onboarding_id,task_id,position,title)
       VALUES ($1,$2,$3,$4)`,
      [onboarding.rows[0].id, task.rows[0].id, index + 1, stepTitle],
    );
    if (support.rows[0]?.id) {
      await queueTaskExecution(client, {
        projectId: lead.project_id,
        agentId: support.rows[0].id,
        taskId: task.rows[0].id,
        title: `Customer onboarding: ${stepTitle}`,
        priority: "normal",
        source: "customer_onboarding",
      });
    }
  }
  await client.query(`INSERT INTO events (source,event_type,title,severity,project_id,payload)
    VALUES ('customer-onboarding','customer_onboarding_started',$1,'info',$2,$3::jsonb)`, [
    `Customer onboarding started: ${lead.opportunity_title}`,
    lead.project_id,
    JSON.stringify({ onboarding_id: onboarding.rows[0].id, sales_lead_id: lead.id, steps_created: onboardingChecklist.length }),
  ]);
  return true;
}
