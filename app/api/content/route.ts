import { NextResponse } from "next/server";
import { apiErrorFrom, databaseUnavailable } from "@/lib/api-errors";
import { getContentData } from "@/lib/data";
import { databaseAvailable, query, transaction } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_TYPES = new Set(["post", "reel", "story", "article"]);
const STATUSES = new Set(["draft", "in_review", "approved", "scheduled", "published"]);

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

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function dateOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) return null;
  return Number.isNaN(new Date(`${match[0]}T12:00:00Z`).getTime()) ? null : match[0];
}

export async function GET() {
  const data = await getContentData();
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return databaseUnavailable();
  try {
    const body = await request.json();
    const projectId = typeof body?.project_id === "string" ? body.project_id : "";
    const type = typeof body?.type === "string" && CONTENT_TYPES.has(body.type) ? body.type : "";
    const title = text(body?.title, 160);
    if (!UUID_PATTERN.test(projectId) || !type || title.length < 3) {
      return NextResponse.json({ error: "Choose a business, a content type, and a title of at least 3 characters." }, { status: 400 });
    }
    const created = await transaction(async (client) => {
      const project = await client.query<{ id: string }>("SELECT id FROM projects WHERE id=$1", [projectId]);
      if (!project.rows[0]) return null;
      const result = await client.query<{ id: string }>(
        `INSERT INTO content_items (project_id,type,title,caption,image_prompt,status,scheduled_for,created_by)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,'owner') RETURNING id`,
        [projectId, type, title, text(body?.caption, 2200), text(body?.image_prompt, 500), dateOrNull(body?.scheduled_for)],
      );
      await client.query(
        `INSERT INTO events (source,event_type,title,severity,project_id,payload)
         VALUES ('content-planner','content_item_created','Owner added content to the planner','info',$1,$2::jsonb)`,
        [projectId, JSON.stringify({ content_item_id: result.rows[0].id, type, title })],
      );
      return result.rows[0].id;
    });
    if (!created) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    return NextResponse.json({ ok: true, id: created });
  } catch (error) {
    return apiErrorFrom(error, "Could not create the content item.", 400);
  }
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return databaseUnavailable();
  try {
    const body = await request.json();

    // Bulk: approve every in-review item for one business in one week —
    // the Lead Desk "approve the week in one sitting" action.
    if (body?.bulk === "approve_week") {
      const projectId = typeof body?.project_id === "string" ? body.project_id : "";
      const weekStart = dateOrNull(body?.week_start);
      if (!UUID_PATTERN.test(projectId) || !weekStart) {
        return NextResponse.json({ error: "A valid project_id and week_start are required." }, { status: 400 });
      }
      const updated = await query<{ id: string }>(
        `UPDATE content_items SET status='approved',updated_at=NOW()
         WHERE project_id=$1 AND status='in_review' AND scheduled_for >= $2::date AND scheduled_for < $2::date + INTERVAL '7 days'
         RETURNING id`,
        [projectId, weekStart],
      );
      return NextResponse.json({ ok: true, approved: updated.rows.length });
    }

    const id = typeof body?.id === "string" ? body.id : "";
    if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "A valid content item id is required." }, { status: 400 });

    const current = await query<{ status: string; scheduled_for: string | null }>("SELECT status,scheduled_for::text FROM content_items WHERE id=$1", [id]);
    if (!current.rows[0]) return NextResponse.json({ error: "Content item not found." }, { status: 404 });

    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => { values.push(value); sets.push(`${column}=$${values.length}`); };
    if (typeof body?.title === "string" && body.title.trim().length >= 3) set("title", text(body.title, 160));
    if (typeof body?.caption === "string") set("caption", text(body.caption, 2200));
    if (typeof body?.image_prompt === "string") set("image_prompt", text(body.image_prompt, 500));
    if (typeof body?.image_url === "string") set("image_url", text(body.image_url, 1000));
    if (typeof body?.published_url === "string") set("published_url", text(body.published_url, 1000));
    if ("scheduled_for" in body) set("scheduled_for", dateOrNull(body.scheduled_for));
    if (typeof body?.status === "string" && STATUSES.has(body.status)) {
      const nextStatus = body.status;
      const effectiveDate = "scheduled_for" in body ? dateOrNull(body.scheduled_for) : current.rows[0].scheduled_for;
      if (nextStatus === "scheduled" && !effectiveDate) {
        return NextResponse.json({ error: "Pick a date before scheduling this item." }, { status: 400 });
      }
      set("status", nextStatus);
    }
    if (!sets.length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

    values.push(id);
    await query(`UPDATE content_items SET ${sets.join(",")},updated_at=NOW() WHERE id=$${values.length}`, values);
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return apiErrorFrom(error, "Could not update the content item.", 400);
  }
}
