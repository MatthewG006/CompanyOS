import { NextResponse } from "next/server";
import { databaseAvailable, query } from "@/lib/db";
import { getDashboardData } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getDashboardData();
  return NextResponse.json({ tasks: data.tasks, source: data.source });
}

export async function POST(request: Request) {
  if (!(await databaseAvailable())) {
    return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  }

  try {
    const body = await request.json();
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const priority = ["critical", "high", "normal", "low"].includes(body?.priority) ? body.priority : "normal";
    const projectSlug = typeof body?.project_slug === "string" ? body.project_slug.trim() : null;
    const agentName = typeof body?.agent_name === "string" ? body.agent_name.trim() : null;

    if (!title) return NextResponse.json({ error: "title is required." }, { status: 400 });

    const projectResult = projectSlug
      ? await query<{ id: string }>("SELECT id FROM projects WHERE slug=$1 LIMIT 1", [projectSlug])
      : { rows: [], rowCount: 0 } as { rows: Array<{ id: string }>; rowCount: number };
    const agentResult = agentName
      ? await query<{ id: string }>("SELECT id FROM agents WHERE LOWER(name)=LOWER($1) LIMIT 1", [agentName])
      : { rows: [], rowCount: 0 } as { rows: Array<{ id: string }>; rowCount: number };

    if (projectSlug && !projectResult.rowCount) return NextResponse.json({ error: `Project not found: ${projectSlug}` }, { status: 404 });
    if (agentName && !agentResult.rowCount) return NextResponse.json({ error: `Agent not found: ${agentName}` }, { status: 404 });

    const inserted = await query<{ id: string }>(
      `INSERT INTO tasks (project_id, agent_id, title, priority, status)
       VALUES ($1,$2,$3,$4,'todo') RETURNING id`,
      [projectResult.rows[0]?.id ?? null, agentResult.rows[0]?.id ?? null, title, priority],
    );

    await query(
      `INSERT INTO events (project_id, source, event_type, title, severity, payload)
       VALUES ($1, 'command-center', 'task_created', $2, 'info', $3::jsonb)`,
      [projectResult.rows[0]?.id ?? null, `Task created: ${title}`, JSON.stringify({ task_id: inserted.rows[0].id, priority })],
    );

    return NextResponse.json({ ok: true, task_id: inserted.rows[0].id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
