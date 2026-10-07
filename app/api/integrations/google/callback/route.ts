import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { databaseAvailable, query } from "@/lib/db";
import { exchangeGoogleCode, fetchGoogleUserInfo, saveGoogleToken, googleConfigured } from "@/lib/integrations/google";
import { verifySignedState } from "@/lib/integrations/oauth-state";

export const dynamic = "force-dynamic";

function redirectHome(request: Request, result: "success" | "error", message?: string) {
  const url = new URL("/communications", request.url);
  url.searchParams.set("google", result);
  if (message) url.searchParams.set("message", message.slice(0, 180));
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  if (!googleConfigured() || !(await databaseAvailable())) return redirectHome(request, "error", "Google OAuth or database is not configured.");
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  if (error) return redirectHome(request, "error", `Google returned ${error}.`);
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("companyos_google_oauth_state")?.value;
  if (!code || !state || !expectedState || state !== expectedState || !verifySignedState(state)) {
    return redirectHome(request, "error", "Google OAuth state validation failed.");
  }
  try {
    const token = await exchangeGoogleCode(code);
    await saveGoogleToken(token);
    const accessToken = token.access_token;
    const userInfo = await fetchGoogleUserInfo(accessToken);
    await query(`UPDATE integration_connections SET status='configured',mode='local',description=$1,updated_at=NOW()
      WHERE name IN ('Gmail','Google Calendar')`, ["Google OAuth"]);
    await query(`INSERT INTO events (source,event_type,title,severity,payload)
      VALUES ('google','oauth_connected','Google account connected to local CompanyOS','info',$1::jsonb)`, [JSON.stringify({ email: userInfo.email ?? null, name: userInfo.name ?? null })]);
    const response = redirectHome(request, "success");
    response.cookies.delete("companyos_google_oauth_state");
    return response;
  } catch (err) {
    return redirectHome(request, "error", err instanceof Error ? err.message : "Google connection failed.");
  }
}
