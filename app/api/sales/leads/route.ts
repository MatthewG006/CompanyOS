import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { apiErrorFrom, databaseUnavailable } from "@/lib/api-errors";
import { databaseAvailable, query, transaction } from "@/lib/db";
import { queueFirstResponse } from "@/lib/ai/first-response";
import { startOnboardingForWonLead } from "@/lib/sales/onboarding";

export const dynamic = "force-dynamic";

const stages = new Set(["new", "qualified", "proposal", "won", "lost"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function parseMoney(value: unknown) {
  const amount = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) return null;
  return Math.round(amount * 100);
}

function parseDate(value: unknown) {
  if (value === "" || value === null || value === undefined) return { valid: true, date: null as Date | null };
  if (typeof value !== "string") return { valid: false, date: null };
  const date = new Date(value);
  return { valid: Number.isFinite(date.getTime()), date: Number.isFinite(date.getTime()) ? date : null };
}

export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return databaseUnavailable();
  const result = await query(`SELECT l.id,l.project_id,p.name AS project_name,l.contact_id,c.name AS contact_name,c.email,c.phone,c.organization,
      l.opportunity_title,l.stage,l.estimated_value_cents::text,l.follow_up_at::text,l.notes,l.source_attention_item_id,l.first_contacted_at::text,l.created_at::text,l.updated_at::text,
      email_pref.status AS email_preference,whatsapp_pref.status AS whatsapp_preference,
      reminder.id AS reminder_id,reminder.status AS reminder_status,reminder.task_id AS reminder_task_id
    FROM sales_leads l JOIN projects p ON p.id=l.project_id JOIN contacts c ON c.id=l.contact_id
    LEFT JOIN contact_channel_preferences email_pref ON email_pref.contact_id=c.id AND email_pref.channel='email'
    LEFT JOIN contact_channel_preferences whatsapp_pref ON whatsapp_pref.contact_id=c.id AND whatsapp_pref.channel='whatsapp'
    LEFT JOIN LATERAL (SELECT id,status,task_id FROM sales_followup_reminders WHERE sales_lead_id=l.id ORDER BY scheduled_for DESC LIMIT 1) reminder ON true
    ORDER BY CASE WHEN l.stage IN ('won','lost') THEN 1 ELSE 0 END,l.follow_up_at ASC NULLS LAST,l.updated_at DESC`);
  return NextResponse.json({ leads: result.rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return databaseUnavailable();

  try {
    const body = await request.json();
    const projectId = typeof body?.project_id === "string" ? body.project_id : "";
    const contactName = typeof body?.contact_name === "string" ? body.contact_name.trim() : "";
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
    const organization = typeof body?.organization === "string" ? body.organization.trim() : "";
    const title = typeof body?.opportunity_title === "string" ? body.opportunity_title.trim() : "";
    const stage = typeof body?.stage === "string" ? body.stage : "new";
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
    const valueCents = parseMoney(body?.estimated_value);
    const followUp = parseDate(body?.follow_up_at);

    if (!uuidPattern.test(projectId)) return NextResponse.json({ error: "Choose a valid project." }, { status: 400 });
    if (!contactName || contactName.length > 160 || organization.length > 160 || title.length < 2 || title.length > 180) {
      return NextResponse.json({ error: "Enter a contact name, an optional organization, and an opportunity title up to 180 characters." }, { status: 400 });
    }
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return NextResponse.json({ error: "Enter a valid email address or leave it blank." }, { status: 400 });
    if (phone.length > 32) return NextResponse.json({ error: "Phone number must be 32 characters or fewer." }, { status: 400 });
    if (!stages.has(stage) || valueCents === null || notes.length > 4000 || !followUp.valid) {
      return NextResponse.json({ error: "Check the stage, estimated value, follow-up date, and notes (up to 4000 characters)." }, { status: 400 });
    }

    const created = await transaction(async (client) => {
      const project = await client.query<{ id: string }>("SELECT id FROM projects WHERE id=$1", [projectId]);
      if (!project.rows[0]) return null;
      const canonicalKey = email ? `email:${email}` : `manual:${randomUUID()}`;
      const contact = await client.query<{ id: string }>(
        `INSERT INTO contacts (canonical_key,name,email,phone,organization,source,project_id,updated_at)
         VALUES ($1,$2,$3,$4,$5,'manual-sales',$6,NOW())
         ON CONFLICT (canonical_key) DO UPDATE SET
           name=COALESCE(contacts.name,EXCLUDED.name),email=COALESCE(contacts.email,EXCLUDED.email),
           phone=COALESCE(contacts.phone,EXCLUDED.phone),
           organization=COALESCE(contacts.organization,EXCLUDED.organization),project_id=COALESCE(contacts.project_id,EXCLUDED.project_id),updated_at=NOW()
         RETURNING id`,
        [canonicalKey, contactName, email || null, phone || null, organization || null, projectId],
      );
      const lead = await client.query<{ id: string }>(
        `INSERT INTO sales_leads (project_id,contact_id,opportunity_title,stage,estimated_value_cents,follow_up_at,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [projectId, contact.rows[0].id, title, stage, valueCents, followUp.date, notes],
      );
      await client.query(`INSERT INTO events (source,event_type,title,severity,project_id,payload)
        VALUES ('sales-pipeline','sales_lead_created',$1,'info',$2,$3::jsonb)`, [
        `Sales opportunity created: ${title}`,
        projectId,
        JSON.stringify({ lead_id: lead.rows[0].id, stage, estimated_value_cents: valueCents }),
      ]);
      // Lead Desk speed rule: a fresh lead gets a first-response task for
      // the Sales agent immediately, queued for autonomous execution.
      if (stage === "new") {
        await queueFirstResponse(client, { projectId, leadId: lead.rows[0].id, leadTitle: title });
      }
      return lead.rows[0];
    });
    if (!created) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    return NextResponse.json({ ok: true, lead_id: created.id });
  } catch (error) {
    return apiErrorFrom(error, "Could not create sales opportunity.", 400);
  }
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return databaseUnavailable();

  try {
    const body = await request.json();
    const leadId = typeof body?.lead_id === "string" ? body.lead_id : "";
    const stage = typeof body?.stage === "string" ? body.stage : "";
    const valueCents = parseMoney(body?.estimated_value);
    const followUp = parseDate(body?.follow_up_at);
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
    if (!uuidPattern.test(leadId) || !stages.has(stage) || valueCents === null || notes.length > 4000 || !followUp.valid) {
      return NextResponse.json({ error: "A valid lead, stage, estimated value, follow-up date, and notes (up to 4000 characters) are required." }, { status: 400 });
    }

    const updated = await transaction(async (client) => {
      const previousResult = await client.query<{ follow_up_at: string | null; stage: string; first_contacted_at: string | null }>("SELECT follow_up_at::text,stage,first_contacted_at::text FROM sales_leads WHERE id=$1 FOR UPDATE", [leadId]);
      const previous = previousResult.rows[0];
      if (!previous) return null;
      const firstContact = previous.stage === "new" && stage !== "new" && !previous.first_contacted_at ? new Date() : null;
      const result = await client.query<{ id: string; project_id: string; opportunity_title: string }>(
        `UPDATE sales_leads SET stage=$2,estimated_value_cents=$3,follow_up_at=$4,notes=$5,first_contacted_at=COALESCE(first_contacted_at,$6),updated_at=NOW()
         WHERE id=$1 RETURNING id,project_id,opportunity_title`,
        [leadId, stage, valueCents, followUp.date, notes, firstContact],
      );
      const lead = result.rows[0];
      if (!lead) return null;
      const previousTime = previous.follow_up_at ? new Date(previous.follow_up_at).getTime() : null;
      const nextTime = followUp.date?.getTime() ?? null;
      const scheduleChanged = previousTime !== nextTime;
      if (scheduleChanged || stage === "won" || stage === "lost") {
        const reminderStatus = stage === "won" || stage === "lost" ? "cancelled" : "superseded";
        await client.query(`UPDATE sales_followup_reminders SET status=$2,completed_at=NOW()
          WHERE sales_lead_id=$1 AND status='open' RETURNING task_id`, [leadId, reminderStatus]);
        await client.query(`UPDATE tasks SET status='done',updated_at=NOW()
          WHERE id IN (SELECT task_id FROM sales_followup_reminders WHERE sales_lead_id=$1 AND status=$2 AND task_id IS NOT NULL)`, [leadId, reminderStatus]);
      }
      if (stage === "won") {
        await startOnboardingForWonLead(client, lead);
      }
      await client.query(`INSERT INTO events (source,event_type,title,severity,project_id,payload)
        VALUES ('sales-pipeline','sales_lead_updated',$1,'info',$2,$3::jsonb)`, [
        `Sales opportunity updated: ${lead.opportunity_title}`,
        lead.project_id,
        JSON.stringify({ lead_id: lead.id, stage, estimated_value_cents: valueCents }),
      ]);
      return lead;
    });
    if (!updated) return NextResponse.json({ error: "Sales opportunity not found." }, { status: 404 });
    return NextResponse.json({ ok: true, lead_id: updated.id, stage });
  } catch (error) {
    return apiErrorFrom(error, "Could not update sales opportunity.", 400);
  }
}
