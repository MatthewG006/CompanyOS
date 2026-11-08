import { NextResponse } from "next/server";
import { triggerN8nMetaWebhook } from "@/lib/integrations/n8n";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await request.json();
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });

    const result = await triggerN8nMetaWebhook({
      event: body?.event ?? "publish_meta_ad",
      project: body?.project ?? "Sky Mountain Graphics",
      title,
      content: body?.content,
      image_url: body?.image_url,
      target_platforms: body?.target_platforms ?? ["facebook", "instagram", "meta_ads"],
      metadata: body?.metadata,
    });

    await query(
      `INSERT INTO events (source, event_type, title, severity, payload)
       VALUES ('n8n-meta', 'ad_published', $1, 'info', $2::jsonb)`,
      [
        `Dispatched ad to n8n Meta workflow: ${title}`,
        JSON.stringify({ title, image_url: body?.image_url, platforms: body?.target_platforms }),
      ],
    ).catch(() => {});

    return NextResponse.json({ ok: true, response: result.response });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to trigger n8n." }, { status: 500 });
  }
}
