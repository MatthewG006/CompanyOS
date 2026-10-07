import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { databaseAvailable, query, transaction } from "@/lib/db";

export const dynamic = "force-dynamic";
const categories = new Set(["sales", "services", "subscriptions", "refund", "infrastructure", "software", "marketing", "operations", "taxes", "other"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

function parseCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell.length === 0) quoted = true;
    else if (character === ",") { row.push(cell.trim()); cell = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value.length)) rows.push(row);
      row = []; cell = "";
    } else cell += character;
    if (cell.length > 5000) throw new Error("A CSV field exceeds the 5,000 character limit.");
  }
  if (quoted) throw new Error("The CSV contains an unclosed quoted field.");
  if (cell.length || row.length) { row.push(cell.trim()); if (row.some((value) => value.length)) rows.push(row); }
  if (!rows.length) throw new Error("The CSV file is empty.");
  return rows;
}

function headerIndex(headers: string[], aliases: string[]) {
  return headers.findIndex((value) => aliases.includes(value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()));
}

function parseDate(value: string) {
  const text = value.trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])) return date.toISOString().slice(0, 10);
  }
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2])));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === Number(match[1]) - 1 && date.getUTCDate() === Number(match[2])) return date.toISOString().slice(0, 10);
  }
  return null;
}

function parseAmount(value: string) {
  let amount = value.trim().replace(/^(USD|\$)\s*/i, "").replace(/,/g, "");
  let parenthesized = false;
  if (/^\(.+\)$/.test(amount)) { parenthesized = true; amount = amount.slice(1, -1); }
  amount = amount.replace(/\$/g, "").replace(/\s*USD$/i, "");
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  const numeric = Number(amount) * (parenthesized ? -1 : 1);
  if (!Number.isFinite(numeric) || numeric === 0 || Math.abs(numeric) > 9_999_999_999.99) return null;
  return { cents: Math.round(Math.abs(numeric) * 100), direction: numeric < 0 ? "expense" as const : "income" as const };
}

function fingerprint(date: string, direction: string, cents: number | string, description: string) {
  const normalized = description.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${date}|${direction}|${cents}|${normalized}`).digest("hex");
}

function parseRows(csv: string) {
  const [rawHeaders, ...dataRows] = parseCsv(csv);
  const headers = rawHeaders.map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  const dateColumn = headerIndex(headers, ["date", "transaction date", "posted date", "posting date"]);
  const descriptionColumn = headerIndex(headers, ["description", "memo", "transaction description", "payee", "details"]);
  const amountColumn = headerIndex(headers, ["amount", "transaction amount", "net amount"]);
  const debitColumn = headerIndex(headers, ["debit", "withdrawal", "withdrawals"]);
  const creditColumn = headerIndex(headers, ["credit", "deposit", "deposits"]);
  if (dateColumn < 0 || descriptionColumn < 0 || (amountColumn < 0 && (debitColumn < 0 || creditColumn < 0))) {
    throw new Error("CSV needs Date, Description, and Amount columns, or Date, Description, Debit, and Credit columns.");
  }
  if (dataRows.length > 500) throw new Error("A single import is limited to 500 rows.");
  const parsed = [];
  for (const [offset, values] of dataRows.entries()) {
    const rowNumber = offset + 2;
    const rawDate = values[dateColumn] ?? "";
    const date = parseDate(rawDate);
    const description = (values[descriptionColumn] ?? "").trim().slice(0, 500);
    let transaction: ReturnType<typeof parseAmount>;
    if (amountColumn >= 0 && (values[amountColumn] ?? "").trim()) {
      transaction = parseAmount(values[amountColumn]);
    } else {
      const debit = (values[debitColumn] ?? "").trim();
      const credit = (values[creditColumn] ?? "").trim();
      if (Boolean(debit) === Boolean(credit)) transaction = null;
      else {
        const parsedAmount = parseAmount(debit || credit);
        transaction = parsedAmount ? { cents: parsedAmount.cents, direction: debit ? "expense" : "income" } : null;
      }
    }
    if (!date || !description || !transaction) throw new Error(`CSV row ${rowNumber} has an invalid date, description, or non-zero amount.`);
    parsed.push({ rowNumber, transactionDate: date, direction: transaction.direction, amountCents: transaction.cents, description, fingerprint: fingerprint(date, transaction.direction, transaction.cents, description) });
  }
  if (!parsed.length) throw new Error("No transaction rows were found in the CSV.");
  return parsed;
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  const [batches, rows] = await Promise.all([
    query(`SELECT b.id,b.file_name,b.status,b.created_at::text,b.completed_at::text,
      COUNT(r.id)::int AS row_count,COUNT(r.id) FILTER (WHERE r.status='pending')::int AS pending_count,
      COUNT(r.id) FILTER (WHERE r.status='duplicate')::int AS duplicate_count,COUNT(r.id) FILTER (WHERE r.status='recorded')::int AS recorded_count
      FROM financial_import_batches b LEFT JOIN financial_import_rows r ON r.batch_id=b.id
      GROUP BY b.id ORDER BY b.created_at DESC LIMIT 12`),
    query(`SELECT r.id,r.batch_id,b.file_name,r.row_number,r.project_id,p.name AS project_name,r.transaction_date::text,
      r.direction,r.amount_cents::text,r.category,r.description,r.status,r.duplicate_note,r.transaction_id
      FROM financial_import_rows r JOIN financial_import_batches b ON b.id=r.batch_id
      LEFT JOIN projects p ON p.id=r.project_id ORDER BY b.created_at DESC,r.row_number LIMIT 500`),
  ]);
  return NextResponse.json({ batches: batches.rows, rows: rows.rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    const csv = typeof body?.csv === "string" ? body.csv : "";
    const fileName = typeof body?.file_name === "string" ? body.file_name.replace(/[\\/]/g, "_").trim().slice(0, 120) : "transactions.csv";
    const projectId = typeof body?.project_id === "string" && body.project_id ? body.project_id : null;
    if (!csv || csv.length > 500_000) return NextResponse.json({ error: "Choose a CSV file no larger than 500 KB." }, { status: 400 });
    if (projectId && !uuidPattern.test(projectId)) return NextResponse.json({ error: "Choose a valid project or Company-wide." }, { status: 400 });
    const parsedRows = parseRows(csv);
    const batch = await transaction(async (client) => {
      if (projectId) {
        const project = await client.query("SELECT id FROM projects WHERE id=$1", [projectId]);
        if (!project.rows[0]) return null;
      }
      const existingTransactions = await client.query<{ transaction_date: string; direction: string; amount_cents: string; description: string; source_fingerprint: string | null }>(
        "SELECT transaction_date::text,direction,amount_cents::text,description,source_fingerprint FROM financial_transactions",
      );
      const existingRows = await client.query<{ fingerprint: string }>("SELECT fingerprint FROM financial_import_rows WHERE status IN ('pending','recorded')");
      const known = new Set(existingRows.rows.map((item) => item.fingerprint));
      for (const item of existingTransactions.rows) known.add(item.source_fingerprint ?? fingerprint(item.transaction_date.slice(0, 10), item.direction, item.amount_cents, item.description));
      const insertedBatch = await client.query<{ id: string }>("INSERT INTO financial_import_batches (file_name) VALUES ($1) RETURNING id", [fileName || "transactions.csv"]);
      const batchId = insertedBatch.rows[0].id;
      let duplicateCount = 0;
      for (const row of parsedRows) {
        const duplicate = known.has(row.fingerprint);
        if (duplicate) duplicateCount += 1;
        await client.query(`INSERT INTO financial_import_rows (batch_id,row_number,project_id,transaction_date,direction,amount_cents,category,description,fingerprint,status,duplicate_note)
          VALUES ($1,$2,$3,$4,$5,$6,'other',$7,$8,$9,$10)`, [batchId,row.rowNumber,projectId,row.transactionDate,row.direction,row.amountCents,row.description,row.fingerprint,duplicate ? "duplicate" : "pending",duplicate ? "Matches an existing ledger or staged import row." : null]);
        known.add(row.fingerprint);
      }
      await client.query(`INSERT INTO events (source,event_type,title,severity,payload)
        VALUES ('finance','financial_import_staged','Financial CSV staged for owner review','info',$1::jsonb)`,
        [JSON.stringify({ batch_id: batchId, row_count: parsedRows.length, duplicate_count: duplicateCount })]);
      return { id: batchId, row_count: parsedRows.length, duplicate_count: duplicateCount };
    });
    if (!batch) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    return NextResponse.json({ ok: true, batch_id: batch.id, row_count: batch.row_count, duplicate_count: batch.duplicate_count });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not stage CSV import." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    const rowId = typeof body?.row_id === "string" ? body.row_id : "";
    const decision = body?.decision === "record" || body?.decision === "record_distinct" || body?.decision === "reject" ? body.decision : "";
    const category = typeof body?.category === "string" ? body.category : "other";
    const projectId = typeof body?.project_id === "string" && body.project_id ? body.project_id : null;
    if (!uuidPattern.test(rowId) || !decision || !categories.has(category) || (projectId && !uuidPattern.test(projectId))) {
      return NextResponse.json({ error: "Provide a valid row, decision, category, and optional project." }, { status: 400 });
    }
    const outcome = await transaction(async (client) => {
      const selected = await client.query<{ id: string; batch_id: string; project_id: string | null; transaction_date: string; direction: "income" | "expense"; amount_cents: string; description: string; fingerprint: string; status: string }>(
        `SELECT id,batch_id,project_id,transaction_date::text,direction,amount_cents::text,description,fingerprint,status
         FROM financial_import_rows WHERE id=$1 FOR UPDATE`, [rowId],
      );
      const row = selected.rows[0];
      if (!row || !["pending", "duplicate"].includes(row.status)) return { error: "Import row is no longer awaiting review." };
      if (decision === "reject") {
        await client.query("UPDATE financial_import_rows SET status='rejected',updated_at=NOW() WHERE id=$1", [rowId]);
        await updateBatchStatus(client, row.batch_id);
        return { status: "rejected" as const };
      }
      if (decision === "record_distinct" && row.status !== "duplicate") return { error: "Only a flagged duplicate can be recorded as a distinct transaction." };
      if (decision === "record" && row.status === "duplicate") return { error: "This row is flagged as a possible duplicate. Use the explicit Record as distinct action only if it is a separate transaction." };
      if (projectId) {
        const project = await client.query("SELECT id FROM projects WHERE id=$1", [projectId]);
        if (!project.rows[0]) return { error: "Project not found." };
      }
      if (row.status === "pending") {
        const possibleDuplicate = await client.query(
          `SELECT id FROM financial_transactions WHERE source_fingerprint=$1 OR
             (transaction_date=$2 AND direction=$3 AND amount_cents=$4 AND LOWER(REGEXP_REPLACE(TRIM(description),'\\s+',' ','g'))=LOWER($5)) LIMIT 1`,
          [row.fingerprint,row.transaction_date,row.direction,row.amount_cents,row.description.replace(/\s+/g, " ").trim()],
        );
        if (possibleDuplicate.rows[0]) {
          await client.query("UPDATE financial_import_rows SET status='duplicate',duplicate_note='Matches a ledger transaction added after this import was staged.',updated_at=NOW() WHERE id=$1", [rowId]);
          return { duplicate: true as const };
        }
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO financial_transactions (project_id,transaction_date,direction,amount_cents,category,description,source_import_row_id,source_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source_import_row_id) WHERE source_import_row_id IS NOT NULL DO NOTHING RETURNING id`,
        [projectId,row.transaction_date,row.direction,row.amount_cents,category,row.description,rowId,row.fingerprint],
      );
      if (!inserted.rows[0]) return { error: "This import row was already recorded." };
      await client.query("UPDATE financial_import_rows SET project_id=$2,category=$3,status='recorded',transaction_id=$4,updated_at=NOW() WHERE id=$1", [rowId,projectId,category,inserted.rows[0].id]);
      await client.query(`INSERT INTO events (source,event_type,title,severity,project_id,payload)
        VALUES ('finance','financial_import_row_recorded','Imported ledger transaction recorded','info',$1,$2::jsonb)`,
        [projectId,JSON.stringify({ transaction_id: inserted.rows[0].id, import_row_id: rowId, batch_id: row.batch_id, direction: row.direction, amount_cents: row.amount_cents, category, transaction_date: row.transaction_date })]);
      await updateBatchStatus(client, row.batch_id);
      return { status: "recorded" as const, transaction_id: inserted.rows[0].id };
    });
    if ("error" in outcome) return NextResponse.json({ error: outcome.error }, { status: 409 });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not review import row." }, { status: 400 });
  }
}

async function updateBatchStatus(client: import("pg").PoolClient, batchId: string) {
  await client.query(`UPDATE financial_import_batches SET status=CASE WHEN EXISTS (
    SELECT 1 FROM financial_import_rows WHERE batch_id=$1 AND status IN ('pending','duplicate')
  ) THEN 'review' ELSE 'completed' END,completed_at=CASE WHEN EXISTS (
    SELECT 1 FROM financial_import_rows WHERE batch_id=$1 AND status IN ('pending','duplicate')
  ) THEN NULL ELSE NOW() END WHERE id=$1`, [batchId]);
}
