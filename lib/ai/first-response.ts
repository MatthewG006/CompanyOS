import type { PoolClient } from "pg";
import { queueTaskExecution } from "@/lib/ai/queue-task-run";

/**
 * The Lead Desk speed rule: a new lead gets a first-response task for the
 * Sales agent the moment it exists, queued for autonomous execution — the
 * 15-minute claim window translated to a single-business agency, where the
 * "claim" is the Sales agent starting work right away. Returns the task id,
 * or null when there is no Sales agent to assign.
 */
export async function queueFirstResponse(
  client: PoolClient,
  input: { projectId: string; leadId: string; leadTitle: string },
): Promise<string | null> {
  const sales = await client.query<{ id: string }>("SELECT id FROM agents WHERE LOWER(name)='sales' LIMIT 1");
  if (!sales.rows[0]) return null;
  const title = `First response: ${input.leadTitle}`.slice(0, 300);
  const task = await client.query<{ id: string }>(
    `INSERT INTO tasks (project_id,agent_id,title,priority,status)
     VALUES ($1,$2,$3,'high','todo') RETURNING id`,
    [input.projectId, sales.rows[0].id, title],
  );
  await queueTaskExecution(client, {
    projectId: input.projectId,
    agentId: sales.rows[0].id,
    taskId: task.rows[0].id,
    title,
    priority: "high",
    source: "new_lead_first_response",
    inputExtras: { lead_id: input.leadId },
  });
  return task.rows[0].id;
}
