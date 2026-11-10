import { NextResponse } from "next/server";
import { apiErrorFrom, databaseUnavailable } from "@/lib/api-errors";
import { databaseAvailable, query } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`
    || request.headers.get("x-companyos-admin-token") === expected;
}

/**
 * Design studio intake: a generator (today the Muse media bridge, later a
 * native integration) submits image variations for a content item. The
 * owner reviews them in the planner and approves one as the item's image —
 * variations never replace the chosen image on their own.
 */
export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return databaseUnavailable();
  try {
    const body = await request.json();
    const id = typeof body?.id === "string" ? body.id : "";
    if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "A valid content item id is required." }, { status: 400 });
    const urls = Array.isArray(body?.image_urls)
      ? body.image_urls.filter((entry: unknown): entry is string => typeof entry === "string" && /^https?:\/\/\S+$/i.test(entry.trim())).map((entry: string) => entry.trim().slice(0, 1000))
      : [];
    if (!urls.length) return NextResponse.json({ error: "Provide at least one http(s) image URL." }, { status: 400 });

    const current = await query<{ image_options: unknown; project_id: string }>("SELECT image_options,project_id FROM content_items WHERE id=$1", [id]);
    if (!current.rows[0]) return NextResponse.json({ error: "Content item not found." }, { status: 404 });
    const existing = Array.isArray(current.rows[0].image_options) ? current.rows[0].image_options.filter((entry): entry is string => typeof entry === "string") : [];
    const merged = [...existing];
    for (const url of urls) if (!merged.includes(url)) merged.push(url);
    const capped = merged.slice(-6);
    await query("UPDATE content_items SET image_options=$2::jsonb,updated_at=NOW() WHERE id=$1", [id, JSON.stringify(capped)]);
    await query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('design-studio','content_image_options_added','Design variations added for owner review','info',$1,$2::jsonb)`,
      [current.rows[0].project_id, JSON.stringify({ content_item_id: id, options: capped.length })],
    );
    return NextResponse.json({ ok: true, id, image_options: capped });
  } catch (error) {
    return apiErrorFrom(error, "Could not add image variations.", 400);
  }
}
