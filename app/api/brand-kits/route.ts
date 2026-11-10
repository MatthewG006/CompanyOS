import { NextResponse } from "next/server";
import { apiErrorFrom, databaseUnavailable } from "@/lib/api-errors";
import { getBrandKitsData } from "@/lib/data";
import { databaseAvailable, transaction } from "@/lib/db";
import { validateWebsiteUrl } from "@/lib/brand-extract";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`
    || request.headers.get("x-companyos-admin-token") === expected;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function textArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const cleaned = entry.trim().slice(0, maxLength);
    if (cleaned && !seen.has(cleaned)) { seen.add(cleaned); items.push(cleaned); }
    if (items.length >= maxItems) break;
  }
  return items;
}

function instagramHandle(value: unknown): string {
  let handle = text(value, 80).replace(/^@+/, "");
  handle = handle.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/$/, "");
  return /^[A-Za-z0-9._]{2,30}$/.test(handle) ? handle : "";
}

export async function GET() {
  const data = await getBrandKitsData();
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return databaseUnavailable();

  try {
    const body = await request.json();
    const projectId = typeof body?.project_id === "string" ? body.project_id : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
      return NextResponse.json({ error: "A valid project_id is required." }, { status: 400 });
    }
    const websiteRaw = text(body?.website_url, 300);
    const websiteUrl = websiteRaw ? validateWebsiteUrl(websiteRaw) : "";
    if (websiteRaw && !websiteUrl) {
      return NextResponse.json({ error: "The website must be a public http(s) URL." }, { status: 400 });
    }
    const kit = {
      website_url: websiteUrl ?? "",
      logo_url: text(body?.logo_url, 500),
      colors: textArray(body?.colors, 8, 40),
      fonts: textArray(body?.fonts, 6, 60),
      phone: text(body?.phone, 40),
      service_area: text(body?.service_area, 200),
      services: textArray(body?.services, 12, 80),
      instagram_username: instagramHandle(body?.instagram_username),
      tagline: text(body?.tagline, 160),
      source: body?.source === "website" ? "website" : "manual",
    };

    const saved = await transaction(async (client) => {
      const project = await client.query<{ id: string; name: string }>("SELECT id,name FROM projects WHERE id=$1", [projectId]);
      if (!project.rows[0]) return null;
      await client.query(`INSERT INTO brand_kits (project_id,website_url,logo_url,colors,fonts,phone,service_area,services,instagram_username,tagline,source)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11)
        ON CONFLICT (project_id) DO UPDATE SET website_url=EXCLUDED.website_url,logo_url=EXCLUDED.logo_url,colors=EXCLUDED.colors,
          fonts=EXCLUDED.fonts,phone=EXCLUDED.phone,service_area=EXCLUDED.service_area,services=EXCLUDED.services,
          instagram_username=EXCLUDED.instagram_username,tagline=EXCLUDED.tagline,source=EXCLUDED.source,updated_at=NOW()`, [
        projectId, kit.website_url, kit.logo_url, JSON.stringify(kit.colors), JSON.stringify(kit.fonts), kit.phone,
        kit.service_area, JSON.stringify(kit.services), kit.instagram_username, kit.tagline, kit.source,
      ]);
      await client.query(`INSERT INTO events (source,event_type,title,severity,project_id,payload)
        VALUES ('owner-brand','brand_kit_updated',$1,'info',$2,$3::jsonb)`, [
        `Brand kit updated: ${project.rows[0].name}`,
        projectId,
        JSON.stringify({ project_id: projectId, source: kit.source, instagram_username: kit.instagram_username }),
      ]);
      return project.rows[0];
    });
    if (!saved) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    return NextResponse.json({ ok: true, project_id: projectId, brand_kit: kit });
  } catch (error) {
    return apiErrorFrom(error, "Could not save the brand kit.", 400);
  }
}
