import { NextResponse } from "next/server";
import { apiErrorFrom, databaseUnavailable } from "@/lib/api-errors";
import { extractBrandFromHtml, validateWebsiteUrl } from "@/lib/brand-extract";
import { databaseAvailable, query } from "@/lib/db";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`
    || request.headers.get("x-companyos-admin-token") === expected;
}

/**
 * Read a business website and propose a brand kit. The proposal is returned
 * for the owner to review in the editor — it is never saved automatically
 * (editor-in-chief rule: extraction proposes, the owner approves).
 */
export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    let target = typeof body?.url === "string" ? body.url.trim() : "";
    const projectId = typeof body?.project_id === "string" ? body.project_id : "";
    if (!target && projectId) {
      if (!(await databaseAvailable())) return databaseUnavailable();
      const stored = await query<{ website_url: string }>("SELECT website_url FROM brand_kits WHERE project_id=$1", [projectId]);
      target = stored.rows[0]?.website_url ?? "";
    }
    const validated = target ? validateWebsiteUrl(target) : null;
    if (!validated) {
      return NextResponse.json({ error: "Provide a public http(s) website URL to read — paste the business website first." }, { status: 400 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try {
      response = await fetch(validated, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": "CompanyOS brand reader (+owner-requested)", accept: "text/html,application/xhtml+xml" },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return NextResponse.json({ error: `The website answered ${response.status}; check the URL and try again.` }, { status: 400 });
    const finalUrl = validateWebsiteUrl(response.url || validated);
    if (!finalUrl) return NextResponse.json({ error: "The website redirected somewhere that cannot be read." }, { status: 400 });
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
      return NextResponse.json({ error: "That URL is not a web page." }, { status: 400 });
    }
    const html = (await response.text()).slice(0, 600_000);
    return NextResponse.json({ ok: true, extraction: extractBrandFromHtml(html, finalUrl) });
  } catch (error) {
    return apiErrorFrom(error, "Could not read that website.", 400);
  }
}
