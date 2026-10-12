import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import pg from "pg";

export const ADMIN_TOKEN = "route-test-token";
const root = process.cwd();

/** A stand-in for Ollama's /api/chat so route tests never reach a real model or the network. */
export type FakeOllama = { url: string; mode: "ok" | "fail"; reply: string; prompts: string[]; formats: unknown[]; close: () => Promise<void> };

export async function startFakeOllama(): Promise<FakeOllama> {
  const fake = { mode: "ok", reply: "Draft: nothing to approve.", prompts: [] as string[], formats: [] as unknown[] } as FakeOllama;
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        fake.prompts.push(parsed.messages?.[0]?.content ?? "");
        fake.formats.push(parsed.format);
      } catch { fake.prompts.push(""); fake.formats.push(undefined); }
      if (fake.mode === "fail") { response.writeHead(500).end("model crashed"); return; }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { content: fake.reply } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake Ollama failed to bind.");
  fake.url = `http://127.0.0.1:${address.port}`;
  fake.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

export type IsolatedDatabase = { url: string; drop: () => Promise<void> };

/**
 * Creates a throwaway database next to DATABASE_URL and migrates it, so route tests (which run the worker,
 * sales reminders and outbound email) never touch real company data. Needs a role that may CREATE DATABASE.
 */
export async function createIsolatedDatabase(adminUrl: string): Promise<IsolatedDatabase> {
  const name = `companyos_routes_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const url = target.toString();
  const drop = async () => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try { await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await client.end(); }
  };
  const migrate = spawnSync(process.execPath, [join(root, "scripts", "migrate.mjs")], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  if (migrate.status !== 0) { await drop(); throw new Error(`Migration of the test database failed:\n${migrate.stdout}${migrate.stderr}`); }
  return { url, drop };
}

export type RunningApp = { baseUrl: string; stop: () => Promise<void>; logs: () => string };

/** Starts the production build (`next start`), so the real proxy and route auth are exercised. */
export async function startApp(env: Record<string, string>): Promise<RunningApp> {
  const port = await freePort();
  let output = "";
  const child: ChildProcess = spawn(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      COMPANYOS_ADMIN_TOKEN: ADMIN_TOKEN,
      // Make real providers unreachable: only the fake Ollama may run.
      CODEX_CLI_PATH: join(root, ".route-tests-no-codex"),
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      AI_AUTO_ALLOW_BILLABLE: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The app exited during startup:\n${output}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`The app did not become ready in 60s:\n${output}`); }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return {
    baseUrl,
    logs: () => output,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }),
  };
}
