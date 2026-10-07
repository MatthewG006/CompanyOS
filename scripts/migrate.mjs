import fs from "node:fs/promises";
import pg from "pg";

const connectionString = process.env.DATABASE_URL ?? "postgres://companyos:companyos_dev_password@localhost:5432/companyos";
const client = new pg.Client({ connectionString });
await client.connect();
const sql = await fs.readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
await client.query(sql);
console.log("CompanyOS database migration complete.");
await client.end();
