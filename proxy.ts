import { type NextRequest, NextResponse } from "next/server";
import { OWNER_SESSION_COOKIE, verifyOwnerSession } from "@/lib/auth/session";

const publicPaths = new Set([
  "/login",
  "/api/auth/login",
  "/api/health",
  "/api/integrations/google/callback",
  "/api/events/ingest",
]);
const internalAuthHeader = "x-companyos-owner-authenticated";

function hasAdminToken(request: NextRequest, expected: string) {
  return request.headers.get("authorization") === `Bearer ${expected}`
    || request.headers.get("x-companyos-admin-token") === expected;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const headers = new Headers(request.headers);
  headers.delete(internalAuthHeader);
  if (process.env.NODE_ENV !== "production") return NextResponse.next({ request: { headers } });

  if (publicPaths.has(pathname)) return NextResponse.next({ request: { headers } });

  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  const authenticated = Boolean(expected && (hasAdminToken(request, expected)
    || await verifyOwnerSession(request.cookies.get(OWNER_SESSION_COOKIE)?.value, expected)));

  if (!authenticated) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const destination = `${pathname}${request.nextUrl.search}`;
    const login = new URL("/login", request.url);
    login.searchParams.set("next", destination);
    return NextResponse.redirect(login);
  }

  if (pathname === "/login") return NextResponse.redirect(new URL("/", request.url));
  headers.set(internalAuthHeader, "true");
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
