import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// CI-completion regression guards: CI must keep exercising the database —
// the Postgres service, the migration step, and the route-integration suite
// are what stop the two DB unit tests from silently skipping forever.

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("CI runs against a real Postgres service", async () => {
  const ci = await read(".github/workflows/ci.yml");
  assert.match(ci, /postgres:\s*\n\s*image: postgres:16/);
  assert.match(ci, /DATABASE_URL: postgres:\/\/companyos:/);
  assert.match(ci, /pg_isready/);
});

test("CI migrates the database before running tests", async () => {
  const ci = await read(".github/workflows/ci.yml");
  const migrate = ci.indexOf("npm run db:migrate");
  const unit = ci.indexOf("run: npm test");
  const routes = ci.indexOf("npm run test:routes");
  assert.ok(migrate !== -1, "CI must run db:migrate");
  assert.ok(routes !== -1, "CI must run the route tests");
  assert.ok(migrate < unit && unit < routes, "order must be migrate, unit tests, route tests");
});
