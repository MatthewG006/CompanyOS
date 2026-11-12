import { NextResponse } from "next/server";
import { apiErrorFrom, databaseUnavailable } from "@/lib/api-errors";
import { databaseAvailable, query } from "@/lib/db";
import { uploadWordPressMediaBytes } from "@/lib/integrations/wordpress";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Generated images arrive as JSON base64, matching how every other route
// in this app takes input. The cap is on the decoded bytes; base64 adds
// roughly a third on the wire.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
};

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`
    || request.headers.get("x-companyos-admin-token") === expected;
}

function boundedText(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").trim().slice(0, limit);
}

/**
 * Image-generation bridge intake: the agent worker generates an image on
 * its own host (Codex imagegen skill) and posts the bytes here. The file
 * is uploaded to the WordPress media library by the server-side adapter —
 * WordPress credentials never leave the server and never reach the
 * worker. When a content item is named, the public URL is appended to
 * its design-studio options with the same semantics as POST
 * /api/content/images (deduplicated, capped, never auto-chosen); the
 * owner still picks the visual in the planner.
 */
export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return databaseUnavailable();
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON image upload is required." }, { status: 400 });

    const contentType = typeof body.content_type === "string" ? body.content_type.split(";")[0].trim().toLowerCase() : "";
    const extensions = IMAGE_TYPES[contentType];
    if (!extensions) {
      return NextResponse.json({ error: "Only PNG, JPEG, WebP, and GIF images can be uploaded." }, { status: 400 });
    }
    const filename = (typeof body.filename === "string" ? body.filename : "")
      .split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ?? "";
    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
    if (!filename || !extensions.includes(extension)) {
      return NextResponse.json({ error: `The filename must end in ${extensions.join(" or ")} for ${contentType} uploads.` }, { status: 400 });
    }
    const dataBase64 = typeof body.data_base64 === "string" ? body.data_base64.trim() : "";
    if (!dataBase64 || dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) || dataBase64.length % 4 === 1) {
      return NextResponse.json({ error: "The image data is missing or is not valid base64." }, { status: 400 });
    }
    const bytes = Buffer.from(dataBase64, "base64");
    if (!bytes.length) return NextResponse.json({ error: "The image data is empty." }, { status: 400 });
    if (bytes.length > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "The image exceeds the 10 MB upload limit." }, { status: 400 });
    }
    const contentItemId = typeof body.content_item_id === "string" && body.content_item_id ? body.content_item_id : null;
    if (contentItemId && !UUID_PATTERN.test(contentItemId)) {
      return NextResponse.json({ error: "A valid content item id is required." }, { status: 400 });
    }
    const title = boundedText(body.title, 200);
    const altText = boundedText(body.alt_text, 300);

    // A named content item is validated before any bytes move, so a bad
    // id can never leave an orphaned file in the media library.
    let item: { image_options: unknown; project_id: string } | null = null;
    if (contentItemId) {
      const current = await query<{ image_options: unknown; project_id: string }>("SELECT image_options,project_id FROM content_items WHERE id=$1", [contentItemId]);
      if (!current.rows[0]) return NextResponse.json({ error: "Content item not found." }, { status: 404 });
      item = current.rows[0];
    }

    const media = await uploadWordPressMediaBytes({
      bytes: new Uint8Array(bytes),
      filename,
      contentType,
      ...(title ? { title } : {}),
      ...(altText ? { altText } : {}),
    });
    const url = media.sourceUrl;
    if (!url) return NextResponse.json({ error: "WordPress did not return a public URL for the uploaded image." }, { status: 502 });

    if (contentItemId && item) {
      const existing = Array.isArray(item.image_options) ? item.image_options.filter((entry): entry is string => typeof entry === "string") : [];
      const merged = [...existing];
      if (!merged.includes(url)) merged.push(url);
      const capped = merged.slice(-6);
      await query("UPDATE content_items SET image_options=$2::jsonb,updated_at=NOW() WHERE id=$1", [contentItemId, JSON.stringify(capped)]);
      await query(
        `INSERT INTO events (source,event_type,title,severity,project_id,payload)
         VALUES ('design-studio','content_image_options_added','Design variations added for owner review','info',$1,$2::jsonb)`,
        [item.project_id, JSON.stringify({ content_item_id: contentItemId, options: capped.length })],
      );
      return NextResponse.json({ ok: true, url, media_id: media.id, content_item_id: contentItemId, image_options: capped });
    }
    return NextResponse.json({ ok: true, url, media_id: media.id });
  } catch (error) {
    return apiErrorFrom(error, "Could not upload the generated image.", 400);
  }
}
