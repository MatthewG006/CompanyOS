import { NextResponse } from "next/server";
import { databaseAvailable, query } from "@/lib/db";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const expected = process.env.COMPANYOS_INGEST_TOKEN;
  return Boolean(expected) && (request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-ingest-token") === expected);
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    const source = typeof body?.source === "string" ? body.source.trim() : "";
    const eventType = typeof body?.event_type === "string" ? body.event_type.trim() : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const severity = ["info", "warning", "critical"].includes(body?.severity) ? body.severity : "info";
    const idempotencyKey = typeof body?.idempotency_key === "string" ? body.idempotency_key.trim().slice(0, 180) : null;
    const payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
    const projectSlug = typeof body?.project_slug === "string" ? body.project_slug.trim() : null;
    if (!source || !eventType || !title) return NextResponse.json({ error: "source, event_type and title are required." }, { status: 400 });
    const project = projectSlug ? await query<{ id: string }>("SELECT id FROM projects WHERE slug=$1 LIMIT 1", [projectSlug]) : { rows: [], rowCount: 0 } as { rows: Array<{ id: string }>; rowCount: number };
    if (projectSlug && !project.rowCount) return NextResponse.json({ error: `Project not found: ${projectSlug}` }, { status: 404 });
    const result = await query<{ id: string }>(`INSERT INTO events (project_id,source,event_type,title,severity,payload,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`, [project.rows[0]?.id ?? null, source, eventType, title.slice(0, 500), severity, JSON.stringify(payload), idempotencyKey]);
    return NextResponse.json({ ok: true, duplicate: result.rowCount === 0, event_id: result.rows[0]?.id ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
