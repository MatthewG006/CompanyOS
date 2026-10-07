"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Project = { id: string; name: string };
type Stage = "new" | "qualified" | "proposal" | "won" | "lost";
type Lead = {
  id: string;
  project_id: string;
  project_name: string;
  contact_name: string | null;
  contact_id: string;
  email: string | null;
  phone: string | null;
  email_preference: "opted_in" | "opted_out" | null;
  whatsapp_preference: "opted_in" | "opted_out" | null;
  organization: string | null;
  opportunity_title: string;
  stage: Stage;
  estimated_value_cents: string;
  follow_up_at: string | null;
  notes: string;
  reminder_id: string | null;
  reminder_status: "open" | "completed" | "superseded" | "cancelled" | null;
  source_attention_item_id: string | null;
};
type LeadDraft = { stage: Stage; estimated_value: string; follow_up_at: string; notes: string };

const stageLabels: Array<{ value: Stage; label: string }> = [
  { value: "new", label: "New" },
  { value: "qualified", label: "Qualified" },
  { value: "proposal", label: "Proposal" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

function toDraft(lead: Lead): LeadDraft {
  const followUp = lead.follow_up_at ? new Date(lead.follow_up_at) : null;
  const localFollowUp = followUp && Number.isFinite(followUp.getTime())
    ? new Date(followUp.getTime() - followUp.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : "";
  return {
    stage: lead.stage,
    estimated_value: (Number(lead.estimated_value_cents) / 100).toFixed(2),
    follow_up_at: localFollowUp,
    notes: lead.notes ?? "",
  };
}

function money(valueCents: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(valueCents) / 100);
}

export function SalesPipeline({ projects, authRequired }: { projects: Project[]; authRequired: boolean }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [drafts, setDrafts] = useState<Record<string, LeadDraft>>({});
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [consentEvidence, setConsentEvidence] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ project_id: projects[0]?.id ?? "", contact_name: "", email: "", phone: "", organization: "", opportunity_title: "", stage: "new" as Stage, estimated_value: "0", follow_up_at: "", notes: "" });

  const headers = useCallback(() => ({ "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }), [token]);
  const refresh = useCallback(async () => {
    const response = await fetch("/api/sales/leads", { headers: headers(), cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load sales opportunities.");
    const loaded = (body.leads ?? []) as Lead[];
    setLeads(loaded);
    setDrafts(Object.fromEntries(loaded.map((lead) => [lead.id, toDraft(lead)])));
  }, [headers]);

  useEffect(() => {
    void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not load sales opportunities."));
  }, [refresh]);

  const totals = useMemo(() => leads.reduce((summary, lead) => {
    const value = Number(lead.estimated_value_cents) || 0;
    summary[lead.stage] += 1;
    if (!["won", "lost"].includes(lead.stage)) summary.pipelineCents += value;
    if (lead.stage === "won") summary.wonCents += value;
    return summary;
  }, { new: 0, qualified: 0, proposal: 0, won: 0, lost: 0, pipelineCents: 0, wonCents: 0 }), [leads]);

  async function createLead(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const payload = { ...form, follow_up_at: form.follow_up_at ? new Date(form.follow_up_at).toISOString() : "" };
      const response = await fetch("/api/sales/leads", { method: "POST", headers: headers(), body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not create sales opportunity.");
      setForm((current) => ({ ...current, contact_name: "", email: "", phone: "", organization: "", opportunity_title: "", estimated_value: "0", follow_up_at: "", notes: "" }));
      setMessage("Opportunity saved to the Company Brain.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create sales opportunity.");
    } finally {
      setBusy(false);
    }
  }

  async function saveLead(lead: Lead) {
    setBusy(true);
    setMessage("");
    try {
      const draft = drafts[lead.id] ?? toDraft(lead);
      const payload = { ...draft, lead_id: lead.id, follow_up_at: draft.follow_up_at ? new Date(draft.follow_up_at).toISOString() : "" };
      const response = await fetch("/api/sales/leads", { method: "PATCH", headers: headers(), body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not update sales opportunity.");
      setMessage("Opportunity updated.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update sales opportunity.");
    } finally {
      setBusy(false);
    }
  }

  async function completeReminder(lead: Lead) {
    if (!lead.reminder_id) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/sales/reminders", { method: "PATCH", headers: headers(), body: JSON.stringify({ reminder_id: lead.reminder_id }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not complete reminder.");
      setMessage("Follow-up reminder completed.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not complete reminder.");
    } finally {
      setBusy(false);
    }
  }

  async function savePreference(lead: Lead, channel: "email" | "whatsapp", status: "opted_in" | "opted_out") {
    setBusy(true);
    setMessage("");
    try {
      const evidence = status === "opted_out" ? "Owner recorded opt-out" : consentEvidence[lead.id] ?? "";
      const response = await fetch("/api/communications/preferences", { method: "PATCH", headers: headers(), body: JSON.stringify({ contact_id: lead.contact_id, channel, status, evidence }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save contact preference.");
      setMessage(`${channel === "email" ? "Email" : "WhatsApp"} preference saved.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save contact preference.");
    } finally { setBusy(false); }
  }

  function updateLeadDraft(leadId: string, key: keyof LeadDraft, value: string) {
    setDrafts((current) => ({ ...current, [leadId]: { ...current[leadId], [key]: value } as LeadDraft }));
  }

  return <div className="sales-workspace">
    {authRequired ? <label className="router-field policy-token">Admin token<input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
    <div className="sales-summary">
      <div><span>Open pipeline</span><strong>{money(String(totals.pipelineCents))}</strong></div>
      <div><span>Won</span><strong>{money(String(totals.wonCents))}</strong></div>
      <div><span>New</span><strong>{totals.new}</strong></div>
      <div><span>Qualified</span><strong>{totals.qualified}</strong></div>
      <div><span>Proposal</span><strong>{totals.proposal}</strong></div>
    </div>
    <section className="panel sales-create-panel">
      <div className="panel-head"><div><h2>Add opportunity</h2><p className="muted">Leads and notes remain owner-managed; agents do not receive this data in task context.</p></div><span className="data-source">OWNER CONTROL</span></div>
      <form className="sales-form" onSubmit={createLead}>
        <label className="router-field">Project<select required value={form.project_id} onChange={(event) => setForm({ ...form, project_id: event.target.value })}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label className="router-field">Contact name<input required maxLength={160} value={form.contact_name} onChange={(event) => setForm({ ...form, contact_name: event.target.value })} /></label>
        <label className="router-field">Email<input type="email" maxLength={254} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label className="router-field">WhatsApp phone<input type="tel" maxLength={32} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
        <label className="router-field">Organization<input maxLength={160} value={form.organization} onChange={(event) => setForm({ ...form, organization: event.target.value })} /></label>
        <label className="router-field sales-opportunity-field">Opportunity<input required minLength={2} maxLength={180} value={form.opportunity_title} onChange={(event) => setForm({ ...form, opportunity_title: event.target.value })} placeholder="Example: Website redesign" /></label>
        <label className="router-field">Stage<select value={form.stage} onChange={(event) => setForm({ ...form, stage: event.target.value as Stage })}>{stageLabels.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select></label>
        <label className="router-field">Estimated value (USD)<input type="number" min="0" max="1000000000" step="0.01" value={form.estimated_value} onChange={(event) => setForm({ ...form, estimated_value: event.target.value })} /></label>
        <label className="router-field">Next follow-up<input type="datetime-local" value={form.follow_up_at} onChange={(event) => setForm({ ...form, follow_up_at: event.target.value })} /></label>
        <label className="router-field sales-notes-field">Notes<textarea maxLength={4000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
        <button type="submit" className="refresh-button" disabled={busy || !form.project_id || (authRequired && !token)}>{busy ? "Saving…" : "Save opportunity"}</button>
      </form>
    </section>
    {message ? <p className="inline-message" role="status">{message}</p> : null}
    <section className="sales-lead-list"><div className="section-title-row"><div><h2>Pipeline</h2><p>Update stages and follow-up dates as the relationship progresses.</p></div><div className="data-source">{leads.length} OPPORTUNITIES</div></div>
      {leads.length ? leads.map((lead) => {
        const draft = drafts[lead.id] ?? toDraft(lead);
        return <article className="panel sales-lead-card" key={lead.id}>
          <div className="sales-lead-heading"><div><span className="sales-project-label">{lead.project_name} · {lead.source_attention_item_id ? "GMAIL · OWNER APPROVED" : "OWNER ENTERED"}</span><h3>{lead.opportunity_title}</h3><p>{lead.contact_name ?? "Unknown contact"}{lead.organization ? ` · ${lead.organization}` : ""}{lead.email ? ` · ${lead.email}` : ""}</p></div><strong className="sales-value">{money(lead.estimated_value_cents)}</strong></div>
          <div className="sales-consent-row"><div><strong>Email:</strong> {lead.email_preference ?? "preference not recorded"}{lead.email ? <>{lead.email_preference === "opted_out" ? <input aria-label={`Email opt-in evidence for ${lead.contact_name ?? "contact"}`} maxLength={500} placeholder="Re-consent source and date" value={consentEvidence[lead.id] ?? ""} onChange={(event) => setConsentEvidence((current) => ({ ...current, [lead.id]: event.target.value }))} /> : null}<button type="button" className="refresh-button" disabled={busy || (lead.email_preference === "opted_out" && !consentEvidence[lead.id]?.trim())} onClick={() => void savePreference(lead, "email", lead.email_preference === "opted_out" ? "opted_in" : "opted_out")}>{lead.email_preference === "opted_out" ? "Record email opt-in" : "Record email opt-out"}</button></> : null}</div><div><strong>WhatsApp:</strong> {lead.whatsapp_preference ?? "no documented opt-in"}{lead.phone ? <><input aria-label={`WhatsApp opt-in evidence for ${lead.contact_name ?? "contact"}`} maxLength={500} placeholder="Consent source and date" value={consentEvidence[lead.id] ?? ""} onChange={(event) => setConsentEvidence((current) => ({ ...current, [lead.id]: event.target.value }))} /><button type="button" className="refresh-button" disabled={busy || !consentEvidence[lead.id]?.trim()} onClick={() => void savePreference(lead, "whatsapp", "opted_in")}>Record WhatsApp opt-in</button><button type="button" className="refresh-button" disabled={busy} onClick={() => void savePreference(lead, "whatsapp", "opted_out")}>Opt out</button></> : <span className="muted"> Add a phone number to track consent.</span>}</div></div>
          {lead.reminder_status ? <div className="sales-reminder-status"><span>Follow-up reminder · {lead.reminder_status === "open" ? "task queued" : lead.reminder_status}</span>{lead.reminder_status === "open" ? <button type="button" className="refresh-button" disabled={busy} onClick={() => void completeReminder(lead)}>Mark completed</button> : null}</div> : null}
          <div className="sales-edit-grid">
            <label className="router-field">Stage<select value={draft.stage} onChange={(event) => updateLeadDraft(lead.id, "stage", event.target.value)}>{stageLabels.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select></label>
            <label className="router-field">Estimated value (USD)<input type="number" min="0" max="1000000000" step="0.01" value={draft.estimated_value} onChange={(event) => updateLeadDraft(lead.id, "estimated_value", event.target.value)} /></label>
            <label className="router-field">Next follow-up<input type="datetime-local" value={draft.follow_up_at} onChange={(event) => updateLeadDraft(lead.id, "follow_up_at", event.target.value)} /></label>
            <label className="router-field sales-notes-field">Owner notes<textarea maxLength={4000} value={draft.notes} onChange={(event) => updateLeadDraft(lead.id, "notes", event.target.value)} /></label>
            <button type="button" className="refresh-button" disabled={busy} onClick={() => void saveLead(lead)}>{busy ? "Saving…" : "Save changes"}</button>
          </div>
        </article>;
      }) : <div className="panel empty-state">No opportunities yet. Add the first lead above.</div>}
    </section>
  </div>;
}
