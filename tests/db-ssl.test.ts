import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDatabaseSsl } from "../lib/db-ssl.ts";

// Postgres SSL: certificates are verified by default whenever SSL is on.
// sslmode=no-verify is the only opt-out, and sslmode never survives into
// the connection string handed to pg.

test("a localhost URL does not use SSL", () => {
  const result = resolveDatabaseSsl("postgres://user:pass@localhost:5432/companyos");
  assert.equal(result.useSsl, false);
});

test("sslmode=disable on a remote URL does not use SSL", () => {
  const result = resolveDatabaseSsl("postgres://user:pass@db.example.com:5432/companyos?sslmode=disable");
  assert.equal(result.useSsl, false);
  assert.ok(!result.cleanedUrl.includes("sslmode"), "sslmode must be stripped from the cleaned URL");
});

test("a Supabase URL uses SSL with certificate verification", () => {
  const result = resolveDatabaseSsl("postgres://user:pass@db.abcdefgh.supabase.co:5432/postgres");
  assert.equal(result.useSsl, true);
  assert.equal(result.rejectUnauthorized, true);
});

test("sslmode=require uses SSL with verification and is stripped", () => {
  const result = resolveDatabaseSsl("postgres://user:pass@db.example.com:5432/companyos?sslmode=require");
  assert.equal(result.useSsl, true);
  assert.equal(result.rejectUnauthorized, true);
  assert.ok(!result.cleanedUrl.includes("sslmode"), "sslmode must be stripped from the cleaned URL");
});

test("sslmode=no-verify uses SSL without verification and is stripped", () => {
  const result = resolveDatabaseSsl("postgres://user:pass@db.example.com:5432/companyos?sslmode=no-verify");
  assert.equal(result.useSsl, true);
  assert.equal(result.rejectUnauthorized, false);
  assert.ok(!result.cleanedUrl.includes("sslmode"), "sslmode must be stripped from the cleaned URL");
});

test("a plain remote URL uses SSL with certificate verification", () => {
  const result = resolveDatabaseSsl("postgres://user:pass@db.example.com:5432/companyos");
  assert.equal(result.useSsl, true);
  assert.equal(result.rejectUnauthorized, true);
  assert.equal(result.cleanedUrl, "postgres://user:pass@db.example.com:5432/companyos");
});
