import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { apiError, apiErrorFrom, databaseUnavailable } from "@/lib/api-errors";
import { databaseAvailable, transaction } from "@/lib/db";
import {
  bodyIntakeSecret,
  buildLeadNotes,
  buildOpportunityTitle,
  GRAPHICS_PROJECT_SLUG,
  INTAKE_SECRET_HEADER,
  intakeAuthStatus,
  parseLeadIntake,
  queryFieldMap,
  queryIntakeSecret,
} from "@/lib/sales/intake";

export const dynamic = "force-dynamic";

/**
 * Public lead intake for the Sky Mountain Graphics website.
 *
 * WordPress (Hash Form, forwarded by the Advanced Form Integration plugin)
 * posts each form submission here with the shared secret — in the
 * x-intake-secret header, as a `secret` field in the JSON body, or as a
 * `key` query parameter on the URL (the free AFI plugin can set neither
 * custom headers nor custom fields, but the destination URL is always
 * editable). The URL may also carry `name_key` / `email_key` /
 * `message_key` parameters naming which body keys hold those fields,
 * because the free AFI webhook posts Hash Form's internal field keys
 * (field_…) rather than the field names. The proxy allowlists this path
 * for that reason; the
 * secret check below is the authentication. A submission becomes a
 * contact, a stage 'new' sales lead for Sky Mountain Graphics, an owner
 * attention item, and a sales-pipeline event — the same records the
 * Sales page creates by hand.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const providedSecret =
    request.headers.get(INTAKE_SECRET_HEADER) ?? bodyIntakeSecret(body) ?? queryIntakeSecret(request.url);
  const auth = intakeAuthStatus(providedSecret, process.env.LEAD_INTAKE_SECRET);
  if (auth === "unconfigured") return apiError("Lead intake is not configured.", 503);
  if (auth === "unauthorized") return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return databaseUnavailable();

  try {
    const parsed = parseLeadIntake(body, queryFieldMap(request.url));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const lead = parsed.lead;
    const opportunityTitle = buildOpportunityTitle(lead.service);
    const notes = buildLeadNotes(lead);

    const created = await transaction(async (client) => {
      const project = await client.query<{ id: string }>(
        "SELECT id FROM projects WHERE slug=$1 LIMIT 1",
        [GRAPHICS_PROJECT_SLUG],
      );
      if (!project.rows[0]) return null;
      const projectId = project.rows[0].id;

      // Match an existing contact by email when one was provided, mirroring
      // the manual Sales flow; otherwise create the contact.
      let contactId: string | null = null;
      if (lead.email) {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM contacts WHERE LOWER(email)=$1 ORDER BY created_at ASC LIMIT 1",
          [lead.email],
        );
        if (existing.rows[0]) {
          contactId = existing.rows[0].id;
          await client.query(
            `UPDATE contacts SET name=COALESCE(name,$2),phone=COALESCE(phone,$3),updated_at=NOW() WHERE id=$1`,
            [contactId, lead.name || null, lead.phone || null],
          );
        }
      }
      if (!contactId) {
        const canonicalKey = lead.email ? `email:${lead.email}` : `website:${randomUUID()}`;
        const contact = await client.query<{ id: string }>(
          `INSERT INTO contacts (canonical_key,name,email,phone,source,project_id,updated_at)
           VALUES ($1,$2,$3,$4,'website-form',$5,NOW())
           ON CONFLICT (canonical_key) DO UPDATE SET
             name=COALESCE(contacts.name,EXCLUDED.name),phone=COALESCE(contacts.phone,EXCLUDED.phone),
             project_id=COALESCE(contacts.project_id,EXCLUDED.project_id),updated_at=NOW()
           RETURNING id`,
          [canonicalKey, lead.name, lead.email || null, lead.phone || null, projectId],
        );
        contactId = contact.rows[0].id;
      }

      const attention = await client.query<{ id: string }>(
        `INSERT INTO attention_items (source,attention_type,priority,title,description,status,project_id,contact_id,updated_at)
         VALUES ('website','new_website_lead','high',$1,$2,'open',$3,$4,NOW())
         RETURNING id`,
        [
          `New website lead: ${lead.name}`,
          `${opportunityTitle} — submitted through the website contact form.`,
          projectId,
          contactId,
        ],
      );

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO sales_leads (project_id,contact_id,opportunity_title,stage,estimated_value_cents,notes,source_attention_item_id)
         VALUES ($1,$2,$3,'new',0,$4,$5) RETURNING id`,
        [projectId, contactId, opportunityTitle, notes, attention.rows[0].id],
      );

      await client.query(
        `INSERT INTO events (source,event_type,title,severity,project_id,payload)
         VALUES ('sales-pipeline','sales_lead_created',$1,'info',$2,$3::jsonb)`,
        [
          `New website lead: ${opportunityTitle}`,
          projectId,
          JSON.stringify({
            lead_id: inserted.rows[0].id,
            contact_id: contactId,
            attention_item_id: attention.rows[0].id,
            intake_source: lead.source,
            stage: "new",
          }),
        ],
      );
      return inserted.rows[0];
    });

    if (!created) return apiError("Sky Mountain Graphics project not found.", 500);
    return NextResponse.json({ ok: true, lead_id: created.id });
  } catch (error) {
    return apiErrorFrom(error, "Could not record the website lead.", 500);
  }
}
