"use client";

import { useCallback, useEffect, useState } from "react";

type Project = { id: string; name: string };
type Contact = { id: string; name: string | null; organization: string | null; project_id: string | null };
type CaseStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";
type SupportCase = { id: string; project_id: string; project_name: string; contact_id: string | null; contact_name: string | null; organization: string | null; task_id: string | null; title: string; description: string; priority: "low" | "normal" | "high" | "critical"; status: CaseStatus; created_at: string; updated_at: string; agent_run_status: string | null };

const statusLabels: Record<CaseStatus, string> = { open: "Open", in_progress: "In progress", waiting: "Waiting", resolved: "Resolved", closed: "Closed" };

function ageLabel(timestamp: string) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 60_000));
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function SupportDesk({ authRequired }: { authRequired: boolean }) {
  const [cases, setCases] = useState<SupportCase[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ project_id: "", contact_id: "", title: "", description: "", priority: "normal" });
  const headers = useCallback(() => ({ "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }), [token]);
  const refresh = useCallback(async () => {
    const response = await fetch("/api/support", { headers: headers(), cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load support cases.");
    setCases((body.cases ?? []) as SupportCase[]);
    setProjects((body.projects ?? []) as Project[]);
    setContacts((body.contacts ?? []) as Contact[]);
    setForm((current) => ({ ...current, project_id: current.project_id || body.projects?.[0]?.id || "" }));
  }, [headers]);

  useEffect(() => { void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not load support cases.")); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh().catch(() => undefined); }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function createCase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/support", { method: "POST", headers: headers(), body: JSON.stringify(form) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not create support case.");
      setForm((current) => ({ ...current, contact_id: "", title: "", description: "", priority: "normal" }));
      setMessage("Internal support case and Support task created.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create support case.");
    } finally { setBusy(false); }
  }

  async function updateStatus(item: SupportCase, status: CaseStatus) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/support", { method: "PATCH", headers: headers(), body: JSON.stringify({ id: item.id, status }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not update support case.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update support case.");
    } finally { setBusy(false); }
  }

  const projectContacts = contacts.filter((contact) => contact.project_id === form.project_id || contact.project_id === null);
  const activeCases = cases.filter((item) => ["open", "in_progress", "waiting"].includes(item.status));
  const highPriorityCases = activeCases.filter((item) => item.priority === "critical" || item.priority === "high");
  const waitingCases = activeCases.filter((item) => item.status === "waiting");
  const oldestActiveCase = activeCases.reduce<SupportCase | null>((oldest, item) => !oldest || new Date(item.created_at).getTime() < new Date(oldest.created_at).getTime() ? item : oldest, null);
  return <div className="support-workspace">
    {authRequired ? <label className="router-field policy-token">Admin token<input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
    <p className="onboarding-boundary">Cases create internal Support tasks. Case details enter agent context only when you enable the Support memory scope; CompanyOS does not reply to customers or change account settings.</p>
    <div className="support-summary"><div><span>Active cases</span><strong>{activeCases.length}</strong></div><div><span>High priority</span><strong>{highPriorityCases.length}</strong></div><div><span>Waiting</span><strong>{waitingCases.length}</strong></div><div><span>Oldest active</span><strong>{oldestActiveCase ? ageLabel(oldestActiveCase.created_at) : "—"}</strong><small>{oldestActiveCase?.title ?? "No active cases"}</small></div></div>
    {message ? <p className="inline-message" role="status">{message}</p> : null}
    <section className="panel support-create-panel">
      <div className="panel-head"><div><h2>Open a support case</h2><p className="muted">Record a customer issue or internal support request.</p></div><span className="data-source">OWNER CONTROL</span></div>
      <form className="support-form" onSubmit={createCase}>
        <label className="router-field">Project<select required value={form.project_id} onChange={(event) => setForm({ ...form, project_id: event.target.value, contact_id: "" })}><option value="" disabled>Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label className="router-field">Contact<select value={form.contact_id} onChange={(event) => setForm({ ...form, contact_id: event.target.value })}><option value="">No linked contact</option>{projectContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || "Unnamed contact"}{contact.organization ? ` · ${contact.organization}` : ""}</option>)}</select></label>
        <label className="router-field">Priority<select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="critical">Critical</option></select></label>
        <label className="router-field support-title-field">Case title<input required minLength={3} maxLength={180} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Brief issue summary" /></label>
        <label className="router-field support-description-field">Description<textarea maxLength={5000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Internal case notes" /></label>
        <button className="refresh-button" type="submit" disabled={busy || !form.project_id || (authRequired && !token)}>{busy ? "Saving…" : "Create case"}</button>
      </form>
    </section>
    <section className="support-case-list"><div className="section-title-row"><div><h2>Cases</h2><p>Update status to keep the linked Support task in sync.</p></div><div className="data-source">{cases.length} CASES</div></div>
      {cases.length ? cases.map((item) => <article className="panel support-case-card" key={item.id}>
        <div className="support-case-heading"><div><span className="sales-project-label">{item.project_name} · {item.priority} · opened {ageLabel(item.created_at)} ago · updated {ageLabel(item.updated_at)} ago</span><h3>{item.title}</h3><p>{item.contact_name ?? "No linked contact"}{item.organization ? ` · ${item.organization}` : ""}</p></div><label className="router-field">Status<select value={item.status} disabled={busy || (authRequired && !token)} onChange={(event) => void updateStatus(item, event.target.value as CaseStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
        {item.description ? <p className="support-case-description">{item.description}</p> : null}
        <span className="support-task-label">{item.task_id ? `Support task linked · agent run ${item.agent_run_status ?? "not queued"}` : "No active task"}</span>
      </article>) : <div className="panel empty-state">No support cases yet. Create an internal case to start the Support workflow.</div>}
    </section>
  </div>;
}
