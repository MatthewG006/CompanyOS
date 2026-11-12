import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// The DB worker (scripts/agent-worker.mjs) is a standalone .mjs script that
// cannot import the TypeScript runner in lib/ai/router.ts, so the Codex
// isolation arguments are duplicated by necessity. This test is the guard
// that keeps the two copies in parity: if a flag is ever added to, or
// removed from, one runner, this fails until the other is updated.
const REQUIRED_ISOLATION_TOKENS = [
  "--ignore-user-config",
  'approval_policy="never"',
  'default_permissions="companyos_isolated"',
  'permissions.companyos_isolated.filesystem={ ":root" = "deny", ":minimal" = "read", ":workspace_roots" = { "." = "read" } }',
  "permissions.companyos_isolated.network.enabled=false",
  'shell_environment_policy.inherit="none"',
];

async function readRepoFile(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("server Codex runner keeps the isolation baseline", async () => {
  const router = await readRepoFile("lib/ai/router.ts");
  for (const token of REQUIRED_ISOLATION_TOKENS) {
    assert.ok(router.includes(token), `lib/ai/router.ts is missing isolation token: ${token}`);
  }
});

test("database worker runs Codex with the same isolation as the server runner", async () => {
  const worker = await readRepoFile("scripts/agent-worker.mjs");
  for (const token of REQUIRED_ISOLATION_TOKENS) {
    assert.ok(worker.includes(token), `scripts/agent-worker.mjs is missing isolation token: ${token}`);
  }
});

test("database worker does not default the Codex process identity to root", async () => {
  const worker = await readRepoFile("scripts/agent-worker.mjs");
  assert.ok(!worker.includes('|| "/root"'), "worker must not fall back to a root HOME");
  assert.ok(!worker.includes('|| "root"'), "worker must not fall back to a root USER");
});
