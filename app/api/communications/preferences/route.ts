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
    const body = await request.json();
    const contactId = typeof body?.contact_id === "string" ? body.contact_id : "";
    const channel = body?.channel === "email" || body?.channel === "whatsapp" ? body.channel : "";
    const status = body?.status === "opted_in" || body?.status === "opted_out" ? body.status : "";
    const evidence = typeof body?.evidence === "string" ? body.evidence.trim().slice(0, 500) : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contactId) || !channel || !status || (status === "opted_in" && evidence.length < 8)) {
      return NextResponse.json({ error: "Provide a valid contact, channel, status, and documented evidence for opt-in." }, { status: 400 });
    }
    const contact = await query<{ id: string }>("SELECT id FROM contacts WHERE id=$1", [contactId]);
    if (!contact.rows[0]) return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    const saved = await query(`INSERT INTO contact_channel_preferences (contact_id,channel,status,evidence,updated_at)
      VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (contact_id,channel) DO UPDATE SET status=EXCLUDED.status,evidence=EXCLUDED.evidence,updated_at=NOW()
      RETURNING contact_id,channel,status,evidence,updated_at::text`, [contactId, channel, status, evidence || "Owner recorded opt-out"]);
    await query(`INSERT INTO events (source,event_type,title,severity,payload) VALUES ('communications','contact_channel_preference_updated',$1,'info',$2::jsonb)`, [
      `${channel === "email" ? "Email" : "WhatsApp"} preference set to ${status}`,
      JSON.stringify({ contact_id: contactId, channel, status }),
    ]);
    return NextResponse.json({ ok: true, preference: saved.rows[0] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save contact preference." }, { status: 400 });
  }
}
