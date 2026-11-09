// Shared DATABASE_URL SSL decision for the Postgres pools.
//
// Certificate verification is on by default whenever SSL is used. The one
// escape hatch is an explicit sslmode=no-verify in the URL, for endpoints
// that present self-signed certificates; sslmode is stripped from the URL
// handed to pg either way, so pg-connection-string cannot override these
// options. scripts/agent-worker.mjs mirrors this rule inline (it cannot
// import this module); tests/worker-ssl-parity.test.ts pins the parity.

export type DatabaseSsl = {
  useSsl: boolean;
  rejectUnauthorized: boolean;
  cleanedUrl: string;
};

export function resolveDatabaseSsl(rawUrl: string): DatabaseSsl {
  const isLocalhost = rawUrl.includes("localhost") || rawUrl.includes("127.0.0.1");
  const sslDisabled = rawUrl.includes("sslmode=disable");
  // Same decision as the previous inline expression in lib/db.ts, with one
  // correction: the generic "sslmode=" presence check no longer re-enables
  // SSL for a URL that explicitly says sslmode=disable.
  const useSsl =
    (!isLocalhost && !sslDisabled) ||
    rawUrl.includes("supabase") ||
    (rawUrl.includes("sslmode=") && !sslDisabled) ||
    rawUrl.includes("render.com") ||
    rawUrl.includes("neon.tech");

  // Only an explicit sslmode=no-verify opts out of certificate verification.
  const rejectUnauthorized = !rawUrl.includes("sslmode=no-verify");

  // Strip sslmode parameters to prevent pg-connection-string from overriding explicit SSL options or raising warnings
  const cleanedUrl = rawUrl.replace(/([?&])sslmode=[^&]*(&|$)/, "$1").replace(/[?&]$/, "");

  return { useSsl, rejectUnauthorized, cleanedUrl };
}
