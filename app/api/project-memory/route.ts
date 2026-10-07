import { NextResponse } from "next/server";
import { databaseAvailable, query, transaction } from "@/lib/db";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`
    || request.headers.get("x-companyos-admin-token") === expected;
}

function denied() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  const memories = await query(`SELECT p.id AS project_id,p.name AS project_name,pm.title,pm.content,pm.updated_at::text
    FROM projects p LEFT JOIN project_memories pm ON pm.project_id=p.id ORDER BY p.name`);
  return NextResponse.json({ memories: memories.rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });

  try {
    const body = await request.json();
    const projectId = typeof body?.project_id === "string" ? body.project_id : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
      return NextResponse.json({ error: "A valid project_id is required." }, { status: 400 });
    }
    if (!title || title.length > 120 || !content || content.length > 5000) {
      return NextResponse.json({ error: "Enter a title up to 120 characters and memory text between 1 and 5000 characters." }, { status: 400 });
    }

    const saved = await transaction(async (client) => {
      const project = await client.query<{ id: string; name: string }>("SELECT id,name FROM projects WHERE id=$1", [projectId]);
      if (!project.rows[0]) return null;
      await client.query(`INSERT INTO project_memories (project_id,title,content)
        VALUES ($1,$2,$3)
        ON CONFLICT (project_id) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,updated_at=NOW()`, [projectId, title, content]);
      await client.query(`INSERT INTO events (source,event_type,title,severity,project_id,payload)
        VALUES ('owner-memory','project_memory_updated',$1,'info',$2,$3::jsonb)`, [
        `Owner memory updated: ${project.rows[0].name}`,
        projectId,
        JSON.stringify({ project_id: projectId, title, character_count: content.length }),
      ]);
      return project.rows[0];
    });
    if (!saved) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    return NextResponse.json({ ok: true, project_id: projectId, title, character_count: content.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save project memory." }, { status: 400 });
  }
}
