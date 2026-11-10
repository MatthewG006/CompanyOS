import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

// Setup-pack regression guards: the documented setup path must keep working —
// every environment variable the code reads is documented in .env.example,
// Node is pinned consistently, scripts only import declared dependencies, and
// the stale duplicate configs stay gone.

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Host/shell variables the code probes but no deployment configures.
const HOST_VARS = new Set(["NODE_ENV", "HOME", "PATH", "TEMP", "TMP", "USER", "USERPROFILE", "WINDIR"]);

async function collectReferencedEnvVars(dir: string): Promise<Set<string>> {
  const found = new Set<string>();
  for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      for (const name of await collectReferencedEnvVars(`${dir}/${entry.name}`)) found.add(name);
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
      const source = await read(`${dir}/${entry.name}`);
      for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
        if (!HOST_VARS.has(match[1])) found.add(match[1]);
      }
    }
  }
  return found;
}

test(".env.example documents every env var the code references", async () => {
  const example = await read(".env.example");
  const documented = new Set(
    [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((match) => match[1]),
  );
  const referenced = new Set<string>();
  for (const dir of ["app", "lib", "components", "scripts"]) {
    for (const name of await collectReferencedEnvVars(dir)) referenced.add(name);
  }
  for (const name of ["proxy.ts", "next.config.ts"]) {
    const source = await read(name);
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
      if (!HOST_VARS.has(match[1])) referenced.add(match[1]);
    }
  }
  const missing = [...referenced].filter((name) => !documented.has(name));
  assert.deepEqual(missing, [], `.env.example must document: ${missing.join(", ")}`);
});

test("Node version is aligned on 24 across engines, .nvmrc, and @types/node", async () => {
  const pkg = JSON.parse(await read("package.json")) as {
    engines?: { node?: string };
    devDependencies?: Record<string, string>;
  };
  assert.match(pkg.engines?.node ?? "", /24/);
  assert.equal((await read(".nvmrc")).trim(), "24");
  assert.match(pkg.devDependencies?.["@types/node"] ?? "", /\^?24/);
});

test("scripts import only declared dependencies (@next/env)", async () => {
  const pkg = JSON.parse(await read("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(declared["@next/env"], "@next/env must be declared; scripts/*.mjs import it");
});

test("CLAUDE.md is a pointer to AGENTS.md, not a stale copy", async () => {
  const claude = await read("CLAUDE.md");
  assert.match(claude, /AGENTS\.md/);
  assert.ok(claude.length < 1000, "CLAUDE.md must stay a short pointer");
});

test("dead eslint config stays deleted and tsbuildinfo stays ignored", async () => {
  await assert.rejects(read("eslint.config.mjs"));
  assert.match(await read(".gitignore"), /^\*\.tsbuildinfo$/m);
});
