import { NextResponse } from "next/server";
import { databaseAvailable, transaction } from "@/lib/db";

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
    const reminderId = typeof body?.reminder_id === "string" ? body.reminder_id : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reminderId)) {
      return NextResponse.json({ error: "A valid reminder is required." }, { status: 400 });
    }
    const completed = await transaction(async (client) => {
      const result = await client.query<{ id: string; task_id: string | null; project_id: string | null }>(
        `SELECT r.id,r.task_id,l.project_id FROM sales_followup_reminders r
         JOIN sales_leads l ON l.id=r.sales_lead_id WHERE r.id=$1 AND r.status='open' FOR UPDATE OF r`, [reminderId],
      );
      const reminder = result.rows[0];
      if (!reminder) return false;
      await client.query("UPDATE sales_followup_reminders SET status='completed',completed_at=NOW() WHERE id=$1", [reminderId]);
      if (reminder.task_id) await client.query("UPDATE tasks SET status='done',updated_at=NOW() WHERE id=$1", [reminder.task_id]);
      await client.query(
        `INSERT INTO events (source,event_type,title,severity,project_id,payload)
         VALUES ('sales-pipeline','sales_followup_reminder_completed','Sales follow-up reminder completed','info',$1,$2::jsonb)`,
        [reminder.project_id, JSON.stringify({ reminder_id: reminder.id, task_id: reminder.task_id })],
      );
      return true;
    });
    return completed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Open reminder not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not complete reminder." }, { status: 400 });
  }
}
