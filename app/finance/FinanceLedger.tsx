"use client";

import { useCallback, useEffect, useState } from "react";

type Project = { id: string; name: string };
type Totals = { income_cents: string; expense_cents: string };
type Entry = { id: string; project_id: string | null; project_name: string | null; source_attention_item_id: string | null; source_import_row_id: string | null; transaction_date: string; direction: "income" | "expense"; amount_cents: string; category: string; description: string; status: "recorded" | "void" };
type ImportBatch = { id: string; file_name: string; status: string; row_count: number; pending_count: number; duplicate_count: number; recorded_count: number; created_at: string };
type ImportRow = { id: string; batch_id: string; file_name: string; row_number: number; project_id: string | null; project_name: string | null; transaction_date: string; direction: "income" | "expense"; amount_cents: string; category: string; description: string; status: "pending" | "duplicate" | "recorded" | "rejected"; duplicate_note: string | null; transaction_id: string | null };
const categories = ["sales", "services", "subscriptions", "refund", "infrastructure", "software", "marketing", "operations", "taxes", "other"];
const today = () => { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
const money = (cents: string | number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(cents) / 100);

export function FinanceLedger({ authRequired }: { authRequired: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [importBatches, setImportBatches] = useState<ImportBatch[]>([]);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [importProjectId, setImportProjectId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [totals, setTotals] = useState<Totals>({ income_cents: "0", expense_cents: "0" });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ project_id: "", transaction_date: "", direction: "income", amount: "", category: "sales", description: "" });
  const headers = useCallback(() => ({ "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }), [token]);
  const refresh = useCallback(async () => {
    const [response, importResponse] = await Promise.all([
      fetch("/api/finance/transactions", { headers: headers(), cache: "no-store" }),
      fetch("/api/finance/imports", { headers: headers(), cache: "no-store" }),
    ]);
    const [body, importBody] = await Promise.all([response.json(), importResponse.json()]);
    if (!response.ok) throw new Error(body.error ?? "Could not load financial ledger.");
    if (!importResponse.ok) throw new Error(importBody.error ?? "Could not load financial imports.");
    setEntries((body.transactions ?? []) as Entry[]);
    setProjects((body.projects ?? []) as Project[]);
    setTotals((body.totals ?? { income_cents: "0", expense_cents: "0" }) as Totals);
    setImportBatches((importBody.batches ?? []) as ImportBatch[]);
    setImportRows((importBody.rows ?? []) as ImportRow[]);
    setForm((current) => ({ ...current, transaction_date: current.transaction_date || today() }));
  }, [headers]);
  useEffect(() => { void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not load financial ledger.")); }, [refresh]);

  async function addEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/finance/transactions", { method: "POST", headers: headers(), body: JSON.stringify({ ...form, project_id: form.project_id || null }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not record transaction.");
      setForm((current) => ({ ...current, amount: "", description: "" }));
      setMessage("Ledger entry recorded.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not record transaction.");
    } finally { setBusy(false); }
  }

  async function setStatus(entry: Entry, status: "recorded" | "void") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/finance/transactions", { method: "PATCH", headers: headers(), body: JSON.stringify({ id: entry.id, status }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not update transaction.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update transaction.");
    } finally { setBusy(false); }
  }

  async function stageCsv() {
    if (!csvFile) return;
    setBusy(true);
    setMessage("");
    try {
      if (!csvFile.name.toLowerCase().endsWith(".csv") || csvFile.size > 500_000) throw new Error("Choose a CSV file no larger than 500 KB.");
      const response = await fetch("/api/finance/imports", { method: "POST", headers: headers(), body: JSON.stringify({ file_name: csvFile.name, csv: await csvFile.text(), project_id: importProjectId || null }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not stage CSV import.");
      setCsvFile(null);
      const input = document.getElementById("finance-csv-file") as HTMLInputElement | null;
      if (input) input.value = "";
      setMessage(`Staged ${body.row_count} rows for owner review. ${body.duplicate_count} possible duplicate(s) flagged.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not stage CSV import.");
    } finally { setBusy(false); }
  }

  async function reviewImportRow(row: ImportRow, decision: "record" | "record_distinct" | "reject") {
    if (decision === "record_distinct" && !window.confirm("This row matches a ledger transaction. Record it as a separate, distinct transaction anyway?")) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/finance/imports", { method: "PATCH", headers: headers(), body: JSON.stringify({ row_id: row.id, decision, category: row.category, project_id: row.project_id || null }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not review import row.");
      setMessage(body.duplicate ? "A matching ledger transaction was added after this import. Review the duplicate warning before proceeding." : decision === "reject" ? "Import row rejected." : decision === "record_distinct" ? "Distinct transaction recorded." : "Imported transaction recorded.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not review import row.");
    } finally { setBusy(false); }
  }

  function editImportRow(rowId: string, key: "category" | "project_id", value: string) {
    setImportRows((current) => current.map((row) => row.id === rowId ? { ...row, [key]: value || null } : row));
  }

  return <div className="ledger-workspace">
    {authRequired ? <label className="router-field policy-token">Admin token<input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
    <p className="onboarding-boundary">Owner-entered USD records only. This ledger does not connect to banks or payment providers and does not initiate payments. Voiding preserves the audit trail.</p>
    {message ? <p className="inline-message" role="status">{message}</p> : null}
    <div className="ledger-summary"><div><span>All-time ledger income</span><strong>{money(totals.income_cents)}</strong></div><div><span>All-time ledger expenses</span><strong>{money(totals.expense_cents)}</strong></div></div>
    <section className="panel ledger-create-panel">
      <div className="panel-head"><div><h2>Record a transaction</h2><p className="muted">Amounts feed the month-to-date finance metrics.</p></div><span className="data-source">OWNER CONTROL</span></div>
      <form className="ledger-form" onSubmit={addEntry}>
        <label className="router-field">Type<select value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value })}><option value="income">Income</option><option value="expense">Expense</option></select></label>
        <label className="router-field">Amount (USD)<input type="number" min="0.01" max="9999999999.99" step="0.01" required value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
        <label className="router-field">Category<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>{categories.map((category) => <option key={category} value={category}>{category[0].toUpperCase() + category.slice(1)}</option>)}</select></label>
        <label className="router-field">Date<input type="date" required value={form.transaction_date} onChange={(event) => setForm({ ...form, transaction_date: event.target.value })} /></label>
        <label className="router-field">Project<select value={form.project_id} onChange={(event) => setForm({ ...form, project_id: event.target.value })}><option value="">Company-wide</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label className="router-field ledger-description">Description<input maxLength={500} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Optional internal note" /></label>
        <button className="refresh-button" type="submit" disabled={busy || (authRequired && !token)}>{busy ? "Saving…" : "Record entry"}</button>
      </form>
    </section>
    <section className="panel ledger-import-panel">
      <div className="panel-head"><div><h2>Import bank CSV</h2><p className="muted">CSV rows are staged only. Nothing enters the ledger until you review and record each row.</p></div><span className="data-source">OWNER REVIEW</span></div>
      <div className="ledger-import-form"><label className="router-field">CSV file<input id="finance-csv-file" type="file" accept=".csv,text/csv" onChange={(event) => setCsvFile(event.target.files?.[0] ?? null)} /></label><label className="router-field">Default project<select value={importProjectId} onChange={(event) => setImportProjectId(event.target.value)}><option value="">Company-wide</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button type="button" className="refresh-button" disabled={busy || !csvFile || (authRequired && !token)} onClick={() => void stageCsv()}>{busy ? "Working…" : "Preview CSV rows"}</button></div>
      <p className="muted import-help">Accepts Date, Description, Amount (negative expenses and positive income), or Date, Description, Debit, Credit. Supports ISO or US dates. Maximum 500 rows / 500 KB.</p>
      <div className="ledger-import-batches">{importBatches.slice(0, 6).map((batch) => <div className="ledger-import-batch" key={batch.id}><div><strong>{batch.file_name}</strong><span>{batch.row_count} rows · {batch.pending_count} awaiting · {batch.duplicate_count} possible duplicates · {batch.recorded_count} recorded</span></div><span className="data-source">{batch.status}</span></div>)}</div>
      <div className="ledger-import-rows">{importRows.filter((row) => ["pending", "duplicate"].includes(row.status)).map((row) => <article className={`ledger-import-row ${row.status}`} key={row.id}>
        <div className="ledger-import-row-main"><span className="sales-project-label">{row.file_name} · row {row.row_number} · {row.transaction_date}</span><strong>{row.description}</strong><span>{row.direction === "expense" ? "−" : "+"}{money(row.amount_cents)}</span>{row.duplicate_note ? <small>{row.duplicate_note}</small> : null}</div>
        <label className="router-field">Category<select value={row.category} onChange={(event) => editImportRow(row.id, "category", event.target.value)}>{categories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
        <label className="router-field">Project<select value={row.project_id ?? ""} onChange={(event) => editImportRow(row.id, "project_id", event.target.value)}><option value="">Company-wide</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <div className="ledger-import-actions">{row.status === "pending" ? <button className="refresh-button" type="button" disabled={busy} onClick={() => void reviewImportRow(row, "record")}>Record row</button> : <button className="refresh-button" type="button" disabled={busy} onClick={() => void reviewImportRow(row, "record_distinct")}>Record as distinct</button>}<button className="refresh-button" type="button" disabled={busy} onClick={() => void reviewImportRow(row, "reject")}>Reject</button></div>
      </article>)}</div>
      {importRows.every((row) => !["pending", "duplicate"].includes(row.status)) ? <div className="empty-state">No imported rows are waiting for review.</div> : null}
    </section>
    <section className="ledger-list"><div className="section-title-row"><div><h2>Recent ledger entries</h2><p>Up to 200 most recent entries.</p></div><div className="data-source">{entries.length} ENTRIES</div></div>
      {entries.length ? entries.map((entry) => <article className={`panel ledger-entry ${entry.status}`} key={entry.id}>
        <div><span className="sales-project-label">{entry.transaction_date} · {entry.project_name ?? "Company-wide"} · {entry.category}</span><h3>{entry.description || entry.category}</h3><span className="ledger-entry-status">{entry.status === "void" ? "Voided · excluded from totals" : entry.source_import_row_id ? "Imported from owner-reviewed CSV" : entry.source_attention_item_id ? "Recorded after Gmail approval" : "Recorded manually"}</span></div>
        <strong className={`ledger-amount ${entry.direction}`}>{entry.direction === "expense" ? "−" : "+"}{money(entry.amount_cents)}</strong>
        <button className="refresh-button ledger-status-action" type="button" disabled={busy || (authRequired && !token)} onClick={() => void setStatus(entry, entry.status === "recorded" ? "void" : "recorded")}>{entry.status === "recorded" ? "Void entry" : "Restore entry"}</button>
      </article>) : <div className="panel empty-state">No ledger entries yet.</div>}
    </section>
  </div>;
}
