import { NextResponse } from "next/server";
import { buildGoogleAuthorizationUrl, googleConfigured } from "@/lib/integrations/google";
import { createSignedState } from "@/lib/integrations/oauth-state";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!googleConfigured()) {
    return NextResponse.json({ error: "Google OAuth is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL and COMPANYOS_ENCRYPTION_KEY." }, { status: 503 });
  }
  const state = createSignedState();
  const response = NextResponse.redirect(buildGoogleAuthorizationUrl(state));
  response.cookies.set("companyos_google_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
  });
  return response;
}
