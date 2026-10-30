import { NextResponse } from "next/server";
import { databaseAvailable, query } from "@/lib/db";
import { encryptSecret } from "@/lib/secrets";
import { getWordPressCredentials, checkWordPressHealth, createWordPressPost } from "@/lib/integrations/wordpress";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const credentials = await getWordPressCredentials();
    if (!credentials) {
      return NextResponse.json({ configured: false, message: "WordPress credentials not found in environment or database." });
    }

    const health = await checkWordPressHealth();
    return NextResponse.json({
      configured: true,
      url: credentials.url,
      username: credentials.username,
      healthy: health.healthy,
      message: health.message,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not retrieve WordPress configuration." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });

  try {
    const body = await request.json();
    const url = typeof body?.url === "string" ? body.url.trim().replace(/\/+$/, "") : "";
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const applicationPassword = typeof body?.application_password === "string" ? body.application_password.trim() : "";

    if (!url || !username || !applicationPassword) {
      return NextResponse.json({ error: "url, username, and application_password are required." }, { status: 400 });
    }

    const payload = {
      url,
      username,
      application_password: applicationPassword,
    };

    const encrypted = encryptSecret(payload);

    await query(
      `INSERT INTO integration_secrets (name, provider, encrypted_value)
       VALUES ('wordpress-skymountain', 'wordpress', $1)
       ON CONFLICT (name) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value, updated_at=NOW()`,
      [encrypted]
    );

    await query(
      `INSERT INTO integration_connections (name, provider, kind, status, mode, description)
       VALUES ('WordPress (Sky Mountain)', 'wordpress', 'cms', 'healthy', 'local', 'WordPress REST API integration for Sky Mountain Graphics.')
       ON CONFLICT (name) DO UPDATE SET status='healthy', updated_at=NOW()`
    );

    return NextResponse.json({ ok: true, message: "WordPress credentials configured successfully." });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save WordPress credentials." }, { status: 400 });
  }
}
