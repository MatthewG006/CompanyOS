import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | null = null;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const rawUrl = process.env.DATABASE_URL;
    const isLocalhost = rawUrl.includes("localhost") || rawUrl.includes("127.0.0.1");
    const sslDisabled = rawUrl.includes("sslmode=disable");
    const useSsl = (!isLocalhost && !sslDisabled) || rawUrl.includes("supabase") || rawUrl.includes("sslmode=") || rawUrl.includes("render.com") || rawUrl.includes("neon.tech");

    // Strip sslmode parameters to prevent pg-connection-string from overriding explicit SSL options or raising warnings
    const cleanedUrl = rawUrl.replace(/([?&])sslmode=[^&]*(&|$)/, "$1").replace(/[?&]$/, "");

    pool = new Pool({
      connectionString: cleanedUrl,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  const db = getPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db.query<T>(text, values);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const db = getPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function databaseAvailable() {
  try {
    const result = await query("SELECT 1");
    // Ensure we actually got a result back before returning true
    return result !== null && result !== undefined;
  } catch (error) {
    console.error("Database connection check failed:", error);
    return false;
  }
}

