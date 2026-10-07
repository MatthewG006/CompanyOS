import { loadEnvConfig } from "@next/env";
import fs from "node:fs/promises";
import pg from "pg";

loadEnvConfig(process.cwd());

const connectionString = process.env.DATABASE_URL ?? "postgres://companyos:companyos_dev_password@localhost:5432/companyos";
const client = new pg.Client({ connectionString });

try {
  await client.connect();
  const sql = await fs.readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await client.query(sql);
  const requiredTables = ["companies", "projects", "agents", "tasks", "events", "financial_transactions", "agent_runs", "workflow_dispatches"];
  const result = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])",
    [requiredTables],
  );
  const found = new Set(result.rows.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !found.has(table));
  if (missing.length) throw new Error(`Migration finished but required tables are still missing: ${missing.join(", ")}`);
  console.log(`CompanyOS database migration complete (${process.env.DATABASE_URL ? "configured DATABASE_URL" : "local default"}).`);
} finally {
  await client.end().catch(() => {});
}
