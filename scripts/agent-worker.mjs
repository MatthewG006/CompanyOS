import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const envFile = await readFile(resolve(process.cwd(), ".env.local"), "utf8").catch(() => "");
for (const line of envFile.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!match || process.env[match[1]] !== undefined) continue;
  const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
  process.env[match[1]] = value;
}

const baseUrl = (process.env.APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const interval = Math.min(60_000, Math.max(1_000, Number(process.env.COMPANYOS_AGENT_WORKER_INTERVAL_MS) || 3_000));
const headers = { "Content-Type": "application/json" };
if (process.env.COMPANYOS_ADMIN_TOKEN) headers.Authorization = `Bearer ${process.env.COMPANYOS_ADMIN_TOKEN}`;
headers["x-companyos-agent-worker-id"] = randomUUID();
let stopping = false;

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

console.log(`CompanyOS agent worker polling ${baseUrl} every ${interval}ms.`);
while (!stopping) {
  try {
    const response = await fetch(`${baseUrl}/api/agent-runs/worker`, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(180_000),
    });
    if (response.status === 401 || response.status === 403) {
      console.error(`Agent worker authorization failed (HTTP ${response.status}). Check COMPANYOS_ADMIN_TOKEN.`);
      process.exitCode = 1;
      break;
    }
    if (!response.ok) {
      console.error(`Agent worker endpoint returned HTTP ${response.status}.`);
    } else {
      const result = await response.json();
      if (result.worked && result.kind === "outbound_email") console.log(`Outbound email ${result.outbound_message_id}: ${result.status}.`);
      else if (result.worked) console.log(`Run ${result.run_id}: ${result.status}${result.approval_proposals ? `; ${result.approval_proposals} approval proposal(s)` : ""}.`);
    }
  } catch (error) {
    console.error(`Agent worker could not reach CompanyOS: ${error instanceof Error ? error.message : "connection error"}`);
  }
  if (!stopping) await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
}
console.log("CompanyOS agent worker stopped.");
