import { NextResponse } from "next/server";
import { databaseAvailable, query } from "@/lib/db";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id : "";
    const status = ["open", "dismissed", "snoozed"].includes(body?.status) ? body.status : "";
    if (!id || !status) return NextResponse.json({ error: "id and status are required." }, { status: 400 });
    await query("UPDATE attention_items SET status=$2,updated_at=NOW() WHERE id=$1", [id, status]);
    await query(`INSERT INTO events (source,event_type,title,severity,payload) VALUES ('command-center','attention_updated',$1,'info',$2::jsonb)`, [`Attention ${status}`, JSON.stringify({ attention_id: id, status })]);
    return NextResponse.json({ ok: true, id, status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
