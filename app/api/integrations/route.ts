import { NextResponse } from "next/server";
import { databaseAvailable, query } from "@/lib/db";
import { getDashboardData } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getDashboardData();
  return NextResponse.json({ integrations: data.integrations, source: data.source });
}

export async function PATCH(request: Request) {
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const status = typeof body?.status === "string" ? body.status.trim() : "";
    const mode = typeof body?.mode === "string" ? body.mode.trim() : "";
    if (!name || !status || !mode) return NextResponse.json({ error: "name, status and mode are required." }, { status: 400 });

    const result = await query<{ id: string }>(
      `UPDATE integration_connections SET status=$2, mode=$3, updated_at=NOW() WHERE name=$1 RETURNING id`,
      [name, status, mode],
    );
    if (!result.rowCount) return NextResponse.json({ error: "Integration not found." }, { status: 404 });
    return NextResponse.json({ ok: true, name, status, mode });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
