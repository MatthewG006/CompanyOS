"use client";

import { useCallback, useEffect, useState } from "react";

type WorkflowRun = {
  id: string;
  workflow_status: string;
  created_at: string;
  category: string | null;
  priority: string;
  project_name: string | null;
  agent_name: string | null;
  task_title: string | null;
  task_status: string | null;
  agent_run_id: string | null;
  agent_run_status: string | null;
  run_summary: string | null;
  run_error: string | null;
  run_started_at: string | null;
  run_completed_at: string | null;
};

export function WorkflowMonitor() {
  const [items, setItems] = useState<WorkflowRun[]>([]);
  const [adminToken, setAdminToken] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/workflows", {
      headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : undefined,
      cache: "no-store",
    });
    const body = await response.json();
    if (response.status === 401) {
      setAuthRequired(true);
      setItems([]);
      setLoaded(true);
      return;
    }
    if (!response.ok) throw new Error(body.error ?? "Could not load workflow status.");
    setAuthRequired(Boolean(body.auth_required));
    setItems(body.workflows ?? []);
    setError("");
    setLoaded(true);
  }, [adminToken]);

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load workflow status.");
      setLoaded(true);
    });
    const timer = window.setInterval(() => {
      void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not refresh workflow status."));
    }, 8000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const failed = items.filter((item) => item.workflow_status === "failed").length;
  const active = items.filter((item) => item.workflow_status === "queued" || item.workflow_status === "running").length;

  return <section className="panel workflow-monitor">
    <div className="panel-head">
      <div><h2>Automated workflow runs</h2><p className="muted">Gmail attention routing · latest 50 · refreshes every eight seconds</p></div>
      <button type="button" className="refresh-button" onClick={() => void refresh()}>Refresh</button>
    </div>
    {authRequired ? <label className="router-field workflow-token">Admin token<input type="password" autoComplete="current-password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
    {authRequired ? <p className="queue-note">Run details are protected by the CompanyOS admin token.</p> : null}
    {error ? <p className="run-error" role="alert">{error}</p> : null}
    {loaded && !authRequired && !error ? <div className="workflow-stats"><span>{active} active</span><span>{failed} failed</span><span>{items.length} shown</span></div> : null}
    {items.length ? <div className="workflow-list">{items.map((item) => <article className="workflow-item" key={item.id}>
      <div className="workflow-heading">
        <div><strong>{(item.category ?? "business").toUpperCase()} · {item.project_name ?? "Unassigned project"}</strong><div className="muted">{item.agent_name ?? "Unassigned agent"} · {item.task_title ?? "Task unavailable"} · {item.task_status ?? "no task"}</div></div>
        <div className="workflow-states"><span className={`run-status ${item.workflow_status}`}>{item.workflow_status.replaceAll("_", " ")}</span>{item.agent_run_status ? <span className={`run-status ${item.agent_run_status}`}>Agent {item.agent_run_status.replaceAll("_", " ")}</span> : null}</div>
      </div>
      {item.run_error ? <p className="run-error">{item.run_error}</p> : null}
      {item.run_summary && item.agent_run_status !== "failed" ? <p className="workflow-summary">{item.run_summary}</p> : null}
      <div className="muted">Created {new Date(item.created_at).toLocaleString()}{item.run_completed_at ? ` · Finished ${new Date(item.run_completed_at).toLocaleString()}` : ""}</div>
    </article>)}</div> : loaded && !authRequired && !error ? <div className="empty-state">No Gmail workflow runs yet. A new unread Sales, Support, or Billing item will appear here after sync.</div> : null}
  </section>;
}
