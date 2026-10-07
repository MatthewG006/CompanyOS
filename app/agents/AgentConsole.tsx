"use client";

import { useCallback, useEffect, useState } from "react";
import type { Task } from "@/lib/types";

type Provider = "auto" | "openai" | "anthropic" | "ollama" | "chatgpt-free" | "claude-free" | "codex" | "codex-cli";
type AgentRun = {
  id: string;
  task_id: string;
  task_title: string;
  provider: Provider;
  model: string | null;
  status: string;
  summary: string | null;
  input: { prompt?: string } | null;
  result: { text?: string } | null;
  error: string | null;
  created_at: string;
  agent_name: string | null;
  retry_run_id: string | null;
  retry_status: string | null;
};
type RunCounts = { queued?: number; running?: number; completed?: number; failed?: number; awaiting_external?: number };
type ProviderStatus = { installed: boolean; authenticated: boolean; message: string };
type AgentWorkerStatus = { status: string; details: { codex_cli_authenticated?: boolean }; last_seen_at: string; online: boolean };

const providerLabels: Record<Provider, string> = {
  auto: "Auto · best available, manual handoff if none",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  ollama: "Ollama local",
  "chatgpt-free": "ChatGPT Free · manual handoff",
  "claude-free": "Claude Free · manual handoff",
  codex: "Codex · manual handoff",
  "codex-cli": "Codex CLI · isolated",
};

export function AgentConsole({ tasks, source }: { tasks: Task[]; source: "database" | "demo" }) {
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [provider, setProvider] = useState<Provider>("auto");
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runCounts, setRunCounts] = useState<RunCounts>({});
  const [configured, setConfigured] = useState<Partial<Record<Provider, boolean>>>({});
  const [codexStatus, setCodexStatus] = useState<ProviderStatus | null>(null);
  const [workerStatus, setWorkerStatus] = useState<AgentWorkerStatus | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [prompt, setPrompt] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [manualOutput, setManualOutput] = useState("");
  const [message, setMessage] = useState("");
  const [queueMessage, setQueueMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const requestHeaders = useCallback(() => ({
    "Content-Type": "application/json",
    ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
  }), [adminToken]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/agent-runs", { headers: requestHeaders(), cache: "no-store" });
    const body = await response.json();
    if (response.status === 401) {
      setAuthRequired(true);
      return;
    }
    if (!response.ok) throw new Error(body.error ?? "Could not load agent runs.");
    setAuthRequired(Boolean(body.auth_required));
    setConfigured(body.providers ?? {});
    setCodexStatus(body.provider_status?.["codex-cli"] ?? null);
    setWorkerStatus(body.agent_worker ?? null);
    setRuns(body.runs ?? []);
    setRunCounts(body.run_counts ?? {});
  }, [requestHeaders]);

  useEffect(() => {
    void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not load agent runs."));
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function runNextQueued() {
    setBusy(true);
    setQueueMessage("");
    try {
      const response = await fetch("/api/agent-runs/worker", { method: "POST", headers: requestHeaders(), body: "{}" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not run queued agent work.");
      if (body.worked) {
        setQueueMessage(`Queued run ${body.status}.${body.approval_proposals ? ` ${body.approval_proposals} proposed action(s) are waiting for owner approval.` : " Results are saved in run history."}`);
      } else {
        setQueueMessage("The queue is empty. Sync Gmail or assign an open task to an agent first.");
      }
      await refresh();
    } catch (error) {
      setQueueMessage(error instanceof Error ? error.message : "Could not run queued agent work.");
    } finally {
      setBusy(false);
    }
  }

  async function retryFailedRun(run: AgentRun) {
    setBusy(true);
    setQueueMessage("");
    try {
      const response = await fetch("/api/agent-runs", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ retry_run_id: run.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not queue the failed run again.");
      setQueueMessage(body.already_retried
        ? `This run already has a retry (${body.status}); no duplicate was queued.`
        : "Retry queued. Start the Codex worker or run the next queued task here.");
      await refresh();
    } catch (error) {
      setQueueMessage(error instanceof Error ? error.message : "Could not queue the failed run again.");
    } finally {
      setBusy(false);
    }
  }

  async function startRun(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!taskId) return;
    setBusy(true);
    setMessage("");
    setPrompt("");
    setActiveRunId("");
    try {
      const response = await fetch("/api/agent-runs", { method: "POST", headers: requestHeaders(), body: JSON.stringify({ task_id: taskId, provider }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Task run failed.");
      if (body.status === "awaiting_external") {
        const handoff = (body.provider ?? provider) as Provider;
        setPrompt(body.prompt);
        setActiveRunId(body.run_id);
        const fellBack = Array.isArray(body.attempts) && body.attempts.length > 0;
        setMessage(`${fellBack ? "Automatic providers were unavailable or failed. " : ""}Prompt prepared for ${providerLabels[handoff] ?? handoff}. Copy it to that service, then submit its response below.`);
      } else {
        const proposalNotice = body.approval_proposals ? ` ${body.approval_proposals} follow-up task proposal(s) are waiting for owner approval on the dashboard.` : "";
        setMessage(`Run completed with ${providerLabels[body.provider as Provider] ?? body.provider} (${body.model}). The result is saved in CompanyOS.${proposalNotice}`);
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start task run.");
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function submitManualResult(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/agent-runs", { method: "PATCH", headers: requestHeaders(), body: JSON.stringify({ run_id: activeRunId, output: manualOutput }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save model response.");
      setPrompt("");
      setManualOutput("");
      setActiveRunId("");
      setMessage(`Model response saved to the CompanyOS run history for owner review.${body.approval_proposals ? ` ${body.approval_proposals} follow-up task proposal(s) are on the dashboard for approval.` : ""}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save model response.");
    } finally {
      setBusy(false);
    }
  }

  function resumeHandoff(run: AgentRun) {
    setActiveRunId(run.id);
    setPrompt(run.input?.prompt ?? "");
    setProvider(run.provider);
    setMessage("This manual handoff is still awaiting a response. Continue with the saved prompt below.");
  }

  return <>
    <section className="panel agent-run-panel">
      <div className="panel-head"><div><h2>Run a task</h2><p className="muted">Runs receive the assigned agent’s scoped project memory. They cannot operate CompanyOS tools or take external actions.</p></div><span className="data-source">{source === "database" ? "POSTGRESQL" : "DEMO MODE"}</span></div>
      {authRequired ? <label className="router-field">Admin token<input type="password" autoComplete="current-password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
      <form className="router-form" onSubmit={startRun}>
        <label className="router-field">Open task<select value={taskId} onChange={(event) => setTaskId(event.target.value)} disabled={source !== "database" || tasks.length === 0}>
          {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}{task.project_name ? ` · ${task.project_name}` : ""}</option>)}
        </select></label>
        <label className="router-field">Provider<select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
          {(Object.keys(providerLabels) as Provider[]).map((key) => <option key={key} value={key} disabled={configured[key] === false}>{providerLabels[key]}{["openai", "anthropic", "ollama"].includes(key) && configured[key] === false ? " · configure server" : key === "codex-cli" && configured[key] === false ? " · sign in required" : ""}</option>)}
        </select></label>
        <button type="submit" className="refresh-button router-submit" disabled={busy || source !== "database" || !tasks.length}>{busy ? "Working…" : "Run task"}</button>
      </form>
      {codexStatus && !codexStatus.authenticated ? <p className="inline-message" role="status">{codexStatus.message}</p> : null}
      {source !== "database" ? <p className="inline-message">Connect PostgreSQL to run and save tasks.</p> : null}
      {message ? <p className="inline-message" role="status">{message}</p> : null}
      {prompt ? <div className="manual-handoff">
        <div className="panel-head"><div><h3>Manual provider prompt</h3><p className="muted">CompanyOS does not sign in to consumer chat plans. Copy the prompt to your chosen service yourself.</p></div><button type="button" className="refresh-button" onClick={() => void navigator.clipboard.writeText(prompt)}>Copy prompt</button></div>
        <textarea aria-label="Task prompt" readOnly value={prompt} />
        <form onSubmit={submitManualResult}>
          <label className="router-field">Paste the model response<textarea required maxLength={30000} value={manualOutput} onChange={(event) => setManualOutput(event.target.value)} placeholder="Paste the response here for review and storage." /></label>
          <button type="submit" className="refresh-button" disabled={busy || !manualOutput.trim()}>{busy ? "Saving…" : "Save response"}</button>
        </form>
      </div> : null}
    </section>
    <section className="panel agent-run-history">
      <div className="panel-head"><div><h2>Agent execution queue</h2><p className="muted">Queued work is claimed by the Codex worker. This page refreshes automatically.</p><div className={`worker-status ${workerStatus?.online ? "online" : "offline"}`}><span />{workerStatus?.online ? `Worker online · Codex CLI ${workerStatus.details.codex_cli_authenticated ? "signed in" : "needs sign-in"}` : "Worker offline"}{workerStatus?.last_seen_at ? ` · last seen ${new Date(workerStatus.last_seen_at).toLocaleString()}` : ""}</div></div><div className="run-toolbar"><button type="button" className="refresh-button" onClick={() => void runNextQueued()} disabled={busy || source !== "database" || configured["codex-cli"] === false}>{busy ? "Working…" : "Run next queued task"}</button><button type="button" className="refresh-button" onClick={() => void refresh()} disabled={busy}>Refresh</button></div></div>
      {authRequired ? <p className="queue-note">Enter the admin token above to view run history or start queued work.</p> : null}
      <section className="run-stats" aria-label="Agent run totals">
        <div><span>Queued</span><strong>{runCounts.queued ?? 0}</strong></div>
        <div><span>Running</span><strong>{runCounts.running ?? 0}</strong></div>
        <div><span>Completed</span><strong>{runCounts.completed ?? 0}</strong></div>
        <div><span>Failed</span><strong>{runCounts.failed ?? 0}</strong></div>
        <div><span>Awaiting handoff</span><strong>{runCounts.awaiting_external ?? 0}</strong></div>
      </section>
      {queueMessage ? <p className="inline-message" role="status">{queueMessage}</p> : null}
      <div className="subsection-title">Recent runs</div>
      {runs.length ? <div className="run-list">{runs.map((run) => <article className="run-item" key={run.id}>
        <div className="run-heading"><div><strong>{run.task_title ?? "Deleted task"}</strong><div className="muted">{run.agent_name ?? "Unassigned agent"} · {providerLabels[run.provider] ?? run.provider}{run.model && run.model !== "manual handoff" ? ` · ${run.model}` : ""}</div></div><span className={`run-status ${run.status}`}>{run.status.replaceAll("_", " ")}</span></div>
        {run.error ? <p className="run-error">{run.error}</p> : null}
        {run.status === "failed" && run.provider === "codex-cli" && !run.retry_run_id ? <button type="button" className="refresh-button" onClick={() => void retryFailedRun(run)} disabled={busy}>{busy ? "Queueing…" : "Retry with Codex"}</button> : null}
        {run.retry_run_id ? <p className="retry-note">Retry attempt: {run.retry_status?.replaceAll("_", " ") ?? "queued"}</p> : null}
        {run.status === "awaiting_external" ? <button type="button" className="refresh-button" onClick={() => resumeHandoff(run)}>Resume handoff</button> : null}
        {run.result?.text ? <details><summary>View saved response</summary><pre>{run.result.text}</pre></details> : null}
      </article>)}</div> : <div className="empty-state">No model runs yet. Choose an open task and provider to begin.</div>}
    </section>
  </>;
}
