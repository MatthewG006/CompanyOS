"use client";

import { useCallback, useEffect, useState } from "react";

type Step = { id: string; task_id: string | null; title: string; status: "todo" | "in_progress" | "blocked" | "done"; position: number; agent_name: string | null };
type Onboarding = { id: string; status: "in_progress" | "completed"; created_at: string; completed_at: string | null; project_name: string; customer_name: string | null; email: string | null; organization: string | null; opportunity_title: string; steps: Step[] };

const statusLabels: Record<Step["status"], string> = { todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done" };

export function OnboardingBoard({ authRequired }: { authRequired: boolean }) {
  const [items, setItems] = useState<Onboarding[]>([]);
  const [token, setToken] = useState("");
  const [busyStep, setBusyStep] = useState("");
  const [message, setMessage] = useState("");

  const headers = useCallback(() => ({ "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }), [token]);
  const refresh = useCallback(async () => {
    const response = await fetch("/api/onboarding", { headers: headers(), cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load onboarding records.");
    setItems((body.onboardings ?? []) as Onboarding[]);
  }, [headers]);

  useEffect(() => {
    void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not load onboarding records."));
  }, [refresh]);

  async function updateStep(step: Step, status: Step["status"]) {
    setBusyStep(step.id);
    setMessage("");
    try {
      const response = await fetch("/api/onboarding", { method: "PATCH", headers: headers(), body: JSON.stringify({ step_id: step.id, status }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not update onboarding step.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update onboarding step.");
    } finally {
      setBusyStep("");
    }
  }

  return <div className="onboarding-workspace">
    {authRequired ? <label className="router-field policy-token">Admin token<input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
    <p className="onboarding-boundary">This checklist creates internal tasks only. CompanyOS does not email customers, provision accounts, or change service settings from this workflow.</p>
    {message ? <p className="inline-message" role="status">{message}</p> : null}
    {items.length ? <div className="onboarding-list">{items.map((item) => {
      const doneCount = item.steps.filter((step) => step.status === "done").length;
      return <section className="panel onboarding-card" key={item.id}>
        <div className="onboarding-card-head"><div><span className="sales-project-label">{item.project_name}</span><h2>{item.customer_name ?? "Customer"}{item.organization ? ` · ${item.organization}` : ""}</h2><p>{item.email ?? "No email recorded"} · {item.opportunity_title}</p></div><span className={`onboarding-status ${item.status}`}>{item.status === "completed" ? "Completed" : "In progress"}</span></div>
        <div className="onboarding-progress"><span>{doneCount} of {item.steps.length} steps complete</span><div><i style={{ width: `${item.steps.length ? (doneCount / item.steps.length) * 100 : 0}%` }} /></div></div>
        <div className="onboarding-steps">{item.steps.map((step) => <div className="onboarding-step" key={step.id}>
          <div><strong>{step.title}</strong><span>{step.agent_name ? `Assigned to ${step.agent_name}` : "Internal checklist task"}</span></div>
          <select aria-label={`Status for ${step.title}`} value={step.status} disabled={busyStep !== "" || (authRequired && !token)} onChange={(event) => void updateStep(step, event.target.value as Step["status"])}>
            {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </div>)}</div>
      </section>;
    })}</div> : <div className="panel empty-state">No customer onboardings yet. Mark a sales opportunity Won to create its onboarding checklist.</div>}
  </div>;
}
