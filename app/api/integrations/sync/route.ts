import { NextResponse } from "next/server";
import { databaseAvailable } from "@/lib/db";
import { isIntegrationConfigured, syncIntegration } from "@/lib/integrations/sync";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

const allowed = new Set(["Gmail", "Google Calendar", "GitHub", "Proxmox", "Nextcloud"]);

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json().catch(() => ({}));
    const requested = typeof body?.integration === "string" ? body.integration : "all";
    const names = requested === "all" ? Array.from(allowed) : [requested];
    if (names.some((name) => !allowed.has(name))) return NextResponse.json({ error: `Unsupported integration. Use one of: ${Array.from(allowed).join(", ")}.` }, { status: 400 });
    const results: Array<{ name: string; seen: number; written: number; status: string; error?: string }> = [];
    for (const name of names) {
      if (!(await isIntegrationConfigured(name))) {
        results.push({ name, seen: 0, written: 0, status: "skipped", error: "Not configured." });
        continue;
      }
      try {
        const result = await syncIntegration(name);
        results.push({ ...result, status: "completed" });
      } catch (error) {
        results.push({ name, seen: 0, written: 0, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return NextResponse.json({ ok: results.every((result) => ["completed", "skipped"].includes(result.status)), results });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
