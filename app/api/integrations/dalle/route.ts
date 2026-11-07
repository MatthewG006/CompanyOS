import { NextResponse } from "next/server";
import { generateDalleImage } from "@/lib/integrations/dalle";
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
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return NextResponse.json({ error: "Image generation prompt is required." }, { status: 400 });

    const size = body?.size ?? "1024x1024";
    const quality = body?.quality ?? "standard";
    const style = body?.style ?? "vivid";

    const result = await generateDalleImage({ prompt, size, quality, style });

    await query(
      `INSERT INTO events (source, event_type, title, severity, payload)
       VALUES ('dalle', 'image_generated', $1, 'info', $2::jsonb)`,
      [
        `DALL-E image generated: ${prompt.slice(0, 100)}`,
        JSON.stringify({ prompt, url: result.url, revised_prompt: result.revised_prompt }),
      ],
    ).catch(() => {});

    return NextResponse.json({ ok: true, url: result.url, revised_prompt: result.revised_prompt });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate image." }, { status: 500 });
  }
}
