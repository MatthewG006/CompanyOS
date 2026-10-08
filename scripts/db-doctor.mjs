import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
import pg from "pg";

loadEnvConfig(process.cwd());

const connectionString = process.env.DATABASE_URL ?? "postgres://companyos:companyos_dev_password@localhost:5432/companyos";
const client = new pg.Client({ connectionString });
const requiredTables = ["companies","projects","agents","tasks","events","financial_transactions","agent_runs","workflow_dispatches"];

try {
  await client.connect();
  const result = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[]) ORDER BY table_name", [requiredTables]);
  const found = new Set(result.rows.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !found.has(table));
  console.log(`CompanyOS database: ${process.env.DATABASE_URL ? "DATABASE_URL" : "local default"}`);
  console.log(`Required tables present: ${requiredTables.length - missing.length}/${requiredTables.length}`);
  if (missing.length) {
    console.error(`Missing tables: ${missing.join(", ")}`);
    console.error("Run: npm run db:migrate");
    process.exitCode = 1;
  } else {
    console.log("Database schema is ready.");
  }
} catch (error) {
  console.error("Could not inspect the CompanyOS database.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
