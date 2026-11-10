import { NextResponse } from "next/server";

/**
 * The standard API error response: `{ error: message }` with a status.
 * Every route returns errors in this shape so clients can rely on it.
 */
export function apiError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Turn a caught value into the standard error response, preferring the
 * caught Error's message and falling back to the route's own wording.
 */
export function apiErrorFrom(error: unknown, fallback: string, status = 500) {
  return apiError(error instanceof Error ? error.message : fallback, status);
}

/** The standard response for write routes when PostgreSQL is unavailable. */
export function databaseUnavailable() {
  return apiError("Database is unavailable.", 503);
}
