import { NextResponse } from "next/server";
import { databaseAvailable, query, transaction } from "@/lib/db";

export const dynamic = "force-dynamic";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const categories = new Set(["sales", "services", "subscriptions", "refund", "infrastructure", "software", "marketing", "operations", "taxes", "other"]);

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

function denied() { return NextResponse.json({ error: "Unauthorized." }, { status: 401 }); }

export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  const [transactions, projects, totals] = await Promise.all([
    query(`SELECT t.id,t.project_id,p.name AS project_name,t.source_attention_item_id,t.source_import_row_id,t.transaction_date::text,t.direction,t.amount_cents::text,
      t.category,t.description,t.status,t.created_at::text,t.updated_at::text
      FROM financial_transactions t LEFT JOIN projects p ON p.id=t.project_id
      ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 200`),
    query("SELECT id,name FROM projects ORDER BY name"),
    query(`SELECT COALESCE(SUM(amount_cents) FILTER (WHERE direction='income'),0)::text AS income_cents,
      COALESCE(SUM(amount_cents) FILTER (WHERE direction='expense'),0)::text AS expense_cents
      FROM financial_transactions WHERE status='recorded'`),
  ]);
  return NextResponse.json({ transactions: transactions.rows, projects: projects.rows, totals: totals.rows[0] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    const projectId = typeof body?.project_id === "string" && body.project_id ? body.project_id : null;
    const direction = typeof body?.direction === "string" ? body.direction : "";
    const amount = typeof body?.amount === "number" || typeof body?.amount === "string" ? Number(body.amount) : Number.NaN;
    const cents = Number.isFinite(amount) ? Math.round(amount * 100) : 0;
    const category = typeof body?.category === "string" ? body.category : "";
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    const date = typeof body?.transaction_date === "string" ? body.transaction_date : "";
    if ((projectId && !uuidPattern.test(projectId)) || !["income", "expense"].includes(direction)
      || !Number.isSafeInteger(cents) || cents <= 0 || cents > 999_999_999_999 || !categories.has(category)
      || !/^\d{4}-\d{2}-\d{2}$/.test(date) || description.length > 500) {
      return NextResponse.json({ error: "Enter a valid type, amount, category, date, optional project, and description up to 500 characters." }, { status: 400 });
    }
    const created = await transaction(async (client) => {
      if (projectId) {
        const project = await client.query("SELECT id FROM projects WHERE id=$1", [projectId]);
        if (!project.rows[0]) return null;
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO financial_transactions (project_id,transaction_date,direction,amount_cents,category,description)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [projectId, date, direction, cents, category, description],
      );
      await client.query(
        `INSERT INTO events (source,event_type,title,severity,project_id,payload)
         VALUES ('finance','financial_transaction_recorded','Financial transaction recorded','info',$1,$2::jsonb)`,
        [projectId, JSON.stringify({ transaction_id: result.rows[0].id, direction, amount_cents: cents, category, transaction_date: date })],
      );
      return result.rows[0];
    });
    if (!created) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    return NextResponse.json({ ok: true, transaction_id: created.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not record transaction." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    const id = typeof body?.id === "string" ? body.id : "";
    const status = typeof body?.status === "string" ? body.status : "";
    if (!uuidPattern.test(id) || !["recorded", "void"].includes(status)) return NextResponse.json({ error: "A valid transaction and status are required." }, { status: 400 });
    const changed = await transaction(async (client) => {
      const selected = await client.query<{ id: string; project_id: string | null }>("SELECT id,project_id FROM financial_transactions WHERE id=$1 FOR UPDATE", [id]);
      if (!selected.rows[0]) return false;
      await client.query("UPDATE financial_transactions SET status=$2,updated_at=NOW() WHERE id=$1", [id, status]);
      await client.query(
        `INSERT INTO events (source,event_type,title,severity,project_id,payload)
         VALUES ('finance','financial_transaction_status_changed','Financial transaction status changed','info',$1,$2::jsonb)`,
        [selected.rows[0].project_id, JSON.stringify({ transaction_id: id, status })],
      );
      return true;
    });
    return changed ? NextResponse.json({ ok: true, id, status }) : NextResponse.json({ error: "Transaction not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update transaction." }, { status: 400 });
  }
}
