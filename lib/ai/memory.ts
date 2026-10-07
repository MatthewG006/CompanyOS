import { query } from "@/lib/db";
import type { AgentMemory } from "@/lib/ai/router";

const supportedScopes = new Set(["project", "tasks", "systems", "sales", "support"]);

export async function loadAgentMemory(projectId: string | null, requestedScopes: unknown, taskId: string | null = null): Promise<AgentMemory> {
  if (!projectId) return {};
  const scopes = new Set(Array.isArray(requestedScopes)
    ? requestedScopes.filter((scope): scope is string => typeof scope === "string" && supportedScopes.has(scope))
    : []);
  const memory: AgentMemory = {};

  if (scopes.has("project")) {
    const result = await query(`SELECT LEFT(c.name,120) AS company,LEFT(p.name,160) AS name,LEFT(p.description,1000) AS description,p.health,p.stage,p.progress
      FROM projects p JOIN companies c ON c.id=p.company_id WHERE p.id=$1`, [projectId]);
    if (result.rows[0]) memory.project = result.rows[0];

    const ownerMemory = await query(`SELECT LEFT(title,120) AS title,LEFT(content,5000) AS content
      FROM project_memories WHERE project_id=$1`, [projectId]);
    if (ownerMemory.rows[0]) memory.owner_managed_project_memory = ownerMemory.rows[0];
  }

  if (scopes.has("tasks")) {
    const result = await query(`SELECT LEFT(t.title,300) AS title,t.priority,t.status,LEFT(a.name,100) AS assigned_agent
      FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.project_id=$1
      ORDER BY t.updated_at DESC LIMIT 8`, [projectId]);
    memory.tasks = result.rows;
  }

  if (scopes.has("systems")) {
    const result = await query(`SELECT LEFT(system_name,120) AS system_name,status,latency_ms,checked_at::text
      FROM system_checks WHERE project_id=$1 ORDER BY checked_at DESC LIMIT 5`, [projectId]);
    memory.systems = result.rows;
  }

  if (scopes.has("sales")) {
    const result = await query<{ opportunity_title: string; stage: string; contact_name: string | null; contact_email: string; organization: string | null }>(`SELECT LEFT(l.opportunity_title,160) AS opportunity_title,l.stage,
        LEFT(c.name,120) AS contact_name,LEFT(c.email,254) AS contact_email,LEFT(c.organization,120) AS organization
      FROM sales_leads l JOIN contacts c ON c.id=l.contact_id
      WHERE l.project_id=$1 AND l.stage IN ('new','qualified','proposal') AND c.email IS NOT NULL
      ORDER BY l.updated_at DESC LIMIT 10`, [projectId]);
    memory.sales_opportunities = result.rows;
  }

  if (scopes.has("support") && taskId) {
    const result = await query<{ case_id: string; title: string; description: string; priority: string; status: string; contact_name: string | null; organization: string | null }>(
      `SELECT sc.id AS case_id,LEFT(sc.title,180) AS title,LEFT(sc.description,3000) AS description,sc.priority,sc.status,
        LEFT(c.name,120) AS contact_name,LEFT(c.organization,120) AS organization
       FROM support_cases sc JOIN tasks t ON t.id=sc.task_id LEFT JOIN contacts c ON c.id=sc.contact_id
       WHERE sc.task_id=$1 AND sc.project_id=$2 LIMIT 1`, [taskId, projectId],
    );
    if (result.rows[0]) memory.support_case = result.rows[0];
  }

  return memory;
}
