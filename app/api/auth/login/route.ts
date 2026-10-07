import { NextResponse } from "next/server";
import { createOwnerSession, OWNER_SESSION_COOKIE, OWNER_SESSION_SECONDS, verifyOwnerToken } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Attempt = { startedAt: number; failures: number; blockedUntil: number };
const attempts = new Map<string, Attempt>();
const windowMs = 15 * 60 * 1000;
const maxFailures = 8;

function clientKey(request: Request) {
  const cloudflareIp = request.headers.get("cf-connecting-ip")?.trim();
  const forwardedIp = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return (cloudflareIp || forwardedIp || "unknown").slice(0, 80);
}

function rateLimited(request: Request) {
  const key = clientKey(request);
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || now - current.startedAt > windowMs) {
    attempts.set(key, { startedAt: now, failures: 0, blockedUntil: 0 });
    return false;
  }
  return current.blockedUntil > now;
}

function recordFailure(request: Request) {
  const key = clientKey(request);
  const now = Date.now();
  const current = attempts.get(key);
  const attempt = !current || now - current.startedAt > windowMs
    ? { startedAt: now, failures: 0, blockedUntil: 0 }
    : current;
  attempt.failures += 1;
  if (attempt.failures >= maxFailures) attempt.blockedUntil = now + windowMs;
  attempts.set(key, attempt);
  if (attempts.size > 2000) {
    for (const [storedKey, storedAttempt] of attempts) {
      if (now - storedAttempt.startedAt > windowMs && storedAttempt.blockedUntil < now) attempts.delete(storedKey);
    }
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" && !process.env.COMPANYOS_ADMIN_TOKEN) {
    return NextResponse.json({ error: "Owner sign-in is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (rateLimited(request)) return NextResponse.json({ error: "Too many sign-in attempts. Wait 15 minutes and try again." }, { status: 429, headers: { "Cache-Control": "no-store" } });

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 4096) return NextResponse.json({ error: "Invalid sign-in request." }, { status: 400 });

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return NextResponse.json({ error: "Invalid sign-in request." }, { status: 400 });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid sign-in request." }, { status: 400 });
  }

  const token = typeof (body as { token?: unknown })?.token === "string" ? (body as { token: string }).token : "";
  if (!(await verifyOwnerToken(token))) {
    recordFailure(request);
    return NextResponse.json({ error: "The owner token is not valid." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  attempts.delete(clientKey(request));
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(OWNER_SESSION_COOKIE, await createOwnerSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: OWNER_SESSION_SECONDS,
  });
  return response;
}
