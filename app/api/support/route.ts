import { NextResponse } from "next/server";
import { databaseAvailable, query, transaction } from "@/lib/db";
import { loadAgentMemory } from "@/lib/ai/memory";
import { buildTaskPrompt } from "@/lib/ai/router";

export const dynamic = "force-dynamic";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(["open", "in_progress", "waiting", "resolved", "closed"]);
const priorities = new Set(["low", "normal", "high", "critical"]);
const manualProviders = new Set(["chatgpt-free", "claude-free", "codex"]);

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

function denied() { return NextResponse.json({ error: "Unauthorized." }, { status: 401 }); }

export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  const [cases, projects, contacts] = await Promise.all([
    query(`SELECT c.id,c.project_id,p.name AS project_name,c.contact_id,co.name AS contact_name,co.organization,
      c.task_id,c.title,c.description,c.priority,c.status,c.created_at::text,c.updated_at::text,c.resolved_at::text,
      (SELECT r.status FROM agent_runs r WHERE r.task_id=c.task_id ORDER BY r.created_at DESC LIMIT 1) AS agent_run_status
      FROM support_cases c JOIN projects p ON p.id=c.project_id LEFT JOIN contacts co ON co.id=c.contact_id
      ORDER BY CASE WHEN c.status IN ('resolved','closed') THEN 1 ELSE 0 END,
      CASE c.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,c.updated_at DESC`),
    query("SELECT id,name FROM projects ORDER BY name"),
    query("SELECT id,name,organization,project_id FROM contacts ORDER BY name NULLS LAST LIMIT 500"),
  ]);
  return NextResponse.json({ cases: cases.rows, projects: projects.rows, contacts: contacts.rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    const projectId = typeof body?.project_id === "string" ? body.project_id : "";
    const contactId = typeof body?.contact_id === "string" && body.contact_id ? body.contact_id : null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    const priority = typeof body?.priority === "string" ? body.priority : "normal";
    if (!uuidPattern.test(projectId) || (contactId && !uuidPattern.test(contactId)) || title.length < 3 || title.length > 180 || description.length > 5000 || !priorities.has(priority)) {
      return NextResponse.json({ error: "Enter a project, case title (3–180 characters), description up to 5000 characters, and valid priority/contact." }, { status: 400 });
    }
    const created = await transaction(async (client) => {
      const project = await client.query("SELECT id FROM projects WHERE id=$1", [projectId]);
      if (!project.rows[0]) return { error: "Project not found." };
      if (contactId) {
        const contact = await client.query("SELECT id FROM contacts WHERE id=$1 AND (project_id=$2 OR project_id IS NULL)", [contactId, projectId]);
        if (!contact.rows[0]) return { error: "Contact is not associated with this project." };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO support_cases (project_id,contact_id,title,description,priority)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`, [projectId, contactId, title, description, priority],
      );
      const supportAgent = await client.query<{
        id: string;
        name: string;
        role: string | null;
        mission: string | null;
        description: string | null;
        provider: string;
        memory_scope: string[];
        allowed_actions: string[];
      }>("SELECT id,name,role,mission,description,provider,memory_scope,allowed_actions FROM agents WHERE LOWER(name)='support' LIMIT 1");
      const agent = supportAgent.rows[0];
      const task = await client.query<{ id: string }>(
        `INSERT INTO tasks (project_id,agent_id,title,priority,status)
         VALUES ($1,$2,$3,$4,'todo') RETURNING id`,
        [projectId, agent?.id ?? null, `Triage support case: ${title}`.slice(0, 200), priority],
      );
      await client.query("UPDATE support_cases SET task_id=$2 WHERE id=$1", [inserted.rows[0].id, task.rows[0].id]);
      let agentRunId: string | null = null;
      if (agent) {
        const isManual = manualProviders.has(agent.provider);
        const workflowContext = {
          category: "support_case",
          support_case_id: inserted.rows[0].id,
        };
        if (isManual) {
          const baseMemory = await loadAgentMemory(projectId, agent.memory_scope, task.rows[0].id);
          const memory = {
            ...baseMemory,
            support_case: {
              case_id: inserted.rows[0].id,
              title,
              description,
              priority,
              status: "open",
              contact_name: null,
              organization: null,
            },
          };
          const prompt = buildTaskPrompt({
            title: `Triage support case: ${title}`.slice(0, 200),
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
          const run = await client.query<{ id: string }>(
            `INSERT INTO agent_runs (agent_id,task_id,provider,model,status,summary,input)
             VALUES ($1,$2,$3,'manual handoff','awaiting_external','Prompt ready for manual provider handoff.',$4::jsonb) RETURNING id`,
            [agent.id, task.rows[0].id, agent.provider, JSON.stringify({
              source: "support-case-workflow",
              prompt,
              task: { title: `Triage support case: ${title}`.slice(0, 200), priority },
              memory,
              workflow_context: workflowContext,
              routing: { requested: agent.provider, manual: agent.provider },
            })],
          );
          agentRunId = run.rows[0].id;
        } else {
          const runProvider = agent.provider === "agnostic" || !agent.provider ? "codex-cli" : agent.provider;
          const run = await client.query<{ id: string }>(
            `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,input)
             VALUES ($1,$2,$3,'queued','Queued by Support case workflow.',$4::jsonb) RETURNING id`,
            [agent.id, task.rows[0].id, runProvider, JSON.stringify({
              source: "support-case-workflow",
              workflow_context: workflowContext,
            })],
          );
          agentRunId = run.rows[0].id;
        }
      }
      await client.query(
        `INSERT INTO events (source,event_type,title,severity,project_id,payload)
         VALUES ('support','support_case_created','Internal support case created',$1,$2,$3::jsonb)`,
        [priority === "critical" ? "critical" : priority === "high" ? "warning" : "info", projectId, JSON.stringify({ support_case_id: inserted.rows[0].id, task_id: task.rows[0].id, agent_run_id: agentRunId, priority })],
      );
      return { id: inserted.rows[0].id, task_id: task.rows[0].id };
    });
    if ("error" in created) return NextResponse.json({ error: created.error }, { status: 404 });
    return NextResponse.json({ ok: true, ...created });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create support case." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    const id = typeof body?.id === "string" ? body.id : "";
    const status = typeof body?.status === "string" ? body.status : "";
    if (!uuidPattern.test(id) || !statuses.has(status)) return NextResponse.json({ error: "A valid case and status are required." }, { status: 400 });
    const updated = await transaction(async (client) => {
      const result = await client.query<{ id: string; task_id: string | null; project_id: string }>("SELECT id,task_id,project_id FROM support_cases WHERE id=$1 FOR UPDATE", [id]);
      const supportCase = result.rows[0];
      if (!supportCase) return null;
      await client.query("UPDATE support_cases SET status=$2,updated_at=NOW(),resolved_at=CASE WHEN $2 IN ('resolved','closed') THEN NOW() ELSE NULL END WHERE id=$1", [id, status]);
      if (supportCase.task_id) {
        const taskStatus = status === "resolved" || status === "closed" ? "done" : status === "in_progress" ? "in_progress" : status === "waiting" ? "blocked" : "todo";
        await client.query("UPDATE tasks SET status=$2,updated_at=NOW() WHERE id=$1", [supportCase.task_id, taskStatus]);
      }
      await client.query(
        `INSERT INTO events (source,event_type,title,severity,project_id,payload)
         VALUES ('support','support_case_updated','Internal support case updated','info',$1,$2::jsonb)`,
        [supportCase.project_id, JSON.stringify({ support_case_id: id, task_id: supportCase.task_id, status })],
      );
      return supportCase;
    });
    return updated ? NextResponse.json({ ok: true, id, status }) : NextResponse.json({ error: "Support case not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update support case." }, { status: 400 });
  }
}
