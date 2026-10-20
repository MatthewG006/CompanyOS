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
type RunCounts = { queued?: number; running?: number; completed?: number; failed?: number; awaiting_external?: number; expired?: number };
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

const providerExternalUrls: Record<string, string> = {
  "chatgpt-free": "https://chatgpt.com",
  "claude-free": "https://claude.ai",
  codex: "https://chatgpt.com/codex",
};

export function AgentConsole({ tasks, source }: { tasks: Task[]; source: "database" | "demo" }) {
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [provider, setProvider] = useState<Provider>("auto");
  const [manualFallback, setManualFallback] = useState<"chatgpt-free" | "claude-free" | "codex">("chatgpt-free");
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runCounts, setRunCounts] = useState<RunCounts>({});
  const [localCap, setLocalCap] = useState<{ limit: number; used: number; capped: boolean } | null>(null);
  const [configured, setConfigured] = useState<Partial<Record<Provider, boolean>>>({});
  const [codexStatus, setCodexStatus] = useState<ProviderStatus | null>(null);
  const [workerStatus, setWorkerStatus] = useState<AgentWorkerStatus | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [prompt, setPrompt] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [activeProvider, setActiveProvider] = useState<Provider>("chatgpt-free");
  const [manualOutput, setManualOutput] = useState("");
  const [message, setMessage] = useState("");
  const [queueMessage, setQueueMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

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
    setLocalCap(body.local_cap ?? null);
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
        : "Retry queued. Start the worker or run the next queued task here.");
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
      const payload: { task_id: string; provider: Provider; manual_provider?: string } = {
        task_id: taskId,
        provider,
      };
      if (provider === "auto") {
        payload.manual_provider = manualFallback;
      }
      const response = await fetch("/api/agent-runs", { method: "POST", headers: requestHeaders(), body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Task run failed.");
      if (body.status === "awaiting_external") {
        const handoff = (body.provider ?? provider) as Provider;
        setPrompt(body.prompt);
        setActiveRunId(body.run_id);
        setActiveProvider(handoff);
        const fellBack = Array.isArray(body.attempts) && body.attempts.length > 0;
        setMessage(`${fellBack ? "Automatic providers were unavailable or failed. " : ""}Prompt prepared for ${providerLabels[handoff] ?? handoff}. Copy it or open the service below, then submit its response.`);
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
      setMessage(`Model response saved to CompanyOS run history for owner review.${body.approval_proposals ? ` ${body.approval_proposals} follow-up task proposal(s) are on the dashboard for approval.` : ""}`);
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
    setActiveProvider(run.provider);
    setMessage(`This manual handoff (${providerLabels[run.provider] ?? run.provider}) is awaiting a response. Continue with the saved prompt below.`);
  }

  function copyPromptToClipboard() {
    if (!prompt) return;
    void navigator.clipboard.writeText(prompt);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2500);
  }

  async function selectTaskAndDispatch(selectedTaskId: string, preferredProvider?: Provider) {
    setTaskId(selectedTaskId);
    const targetProvider = preferredProvider ?? provider;
    if (preferredProvider) {
      setProvider(preferredProvider);
    }
    setBusy(true);
    setMessage("");
    setPrompt("");
    setActiveRunId("");
    try {
      const payload: { task_id: string; provider: Provider; manual_provider?: string } = {
        task_id: selectedTaskId,
        provider: targetProvider,
      };
      if (targetProvider === "auto") {
        payload.manual_provider = manualFallback;
      }
      const response = await fetch("/api/agent-runs", { method: "POST", headers: requestHeaders(), body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Task run failed.");

      if (body.status === "queued" || body.status === "running") {
        // Automatically attempt worker execution for queued runs
        try {
          const workerRes = await fetch("/api/agent-runs/worker", { method: "POST", headers: requestHeaders(), body: "{}" });
          const workerBody = await workerRes.json();
          if (workerRes.ok && workerBody.worked) {
            setMessage(`Task dispatched & worker completed run: ${workerBody.status}.${workerBody.approval_proposals ? ` ${workerBody.approval_proposals} proposed action(s) created.` : ""}`);
          } else {
            setMessage("Task dispatched and queued for processing.");
          }
        } catch {
          setMessage("Task dispatched and queued for background worker.");
        }
      } else if (body.status === "awaiting_external") {
        const handoff = (body.provider ?? targetProvider) as Provider;
        setPrompt(body.prompt);
        setActiveRunId(body.run_id);
        setActiveProvider(handoff);
        const fellBack = Array.isArray(body.attempts) && body.attempts.length > 0;
        setMessage(`${fellBack ? "Automatic providers were unavailable or failed. " : ""}Prompt prepared for ${providerLabels[handoff] ?? handoff}. Copy it or open the service below, then submit its response.`);
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

    const targetElement = document.getElementById("task-runner-form");
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: "smooth" });
    }
  }

  return <>
    {tasks.length > 0 ? (
      <section className="panel task-board-panel" style={{ marginBottom: "1.5rem" }}>
        <div className="panel-head">
          <div>
            <h2>Open tasks & AI dispatch</h2>
            <p className="muted">Directly dispatch any open project task to its assigned AI agent or provider.</p>
          </div>
          <span className="data-source">{tasks.length} OPEN TASKS</span>
        </div>
        <div className="list-stack">
          {tasks.slice(0, 8).map((task) => (
            <div className="list-item" key={task.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                  <span className={`priority-badge ${task.priority}`}>{task.priority}</span>
                  <strong>{task.title}</strong>
                </div>
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  {task.project_name ?? "Company-wide"} · Assigned: {task.agent_name ?? "Unassigned"} · Status: {task.status}
                </div>
              </div>
              <button
                type="button"
                className="refresh-button"
                style={{ fontSize: "0.85rem", whiteSpace: "nowrap" }}
                onClick={() => selectTaskAndDispatch(task.id)}
              >
                Select & dispatch →
              </button>
            </div>
          ))}
        </div>
      </section>
    ) : null}

    <section className="panel agent-run-panel" id="task-runner-form">
      <div className="panel-head">
        <div>
          <h2>Dispatch a task</h2>
          <p className="muted">Runs receive the assigned agent’s scoped project memory. Manual handoffs let ChatGPT Free, Claude Free, and Codex process tasks without API credentials.</p>
        </div>
        <span className="data-source">{source === "database" ? "POSTGRESQL" : "DEMO MODE"}</span>
      </div>
      {authRequired ? <label className="router-field">Admin token<input type="password" autoComplete="current-password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
      <form className="router-form" onSubmit={startRun}>
        <label className="router-field">Open task<select value={taskId} onChange={(event) => setTaskId(event.target.value)} disabled={source !== "database" || tasks.length === 0}>
          {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}{task.project_name ? ` · ${task.project_name}` : ""}{task.agent_name ? ` (${task.agent_name})` : ""}</option>)}
        </select></label>
        <label className="router-field">Execution provider<select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
          {(Object.keys(providerLabels) as Provider[]).map((key) => <option key={key} value={key} disabled={configured[key] === false}>{providerLabels[key]}{["openai", "anthropic", "ollama"].includes(key) && configured[key] === false ? " · configure server" : key === "codex-cli" && configured[key] === false ? " · sign in required" : ""}</option>)}
        </select></label>
        {provider === "auto" ? (
          <label className="router-field">
            Manual fallback if auto-routing unavailable
            <select value={manualFallback} onChange={(event) => setManualFallback(event.target.value as "chatgpt-free" | "claude-free" | "codex")}>
              <option value="chatgpt-free">ChatGPT Free (Manual handoff)</option>
              <option value="claude-free">Claude Free (Manual handoff)</option>
              <option value="codex">Codex (Manual handoff)</option>
            </select>
          </label>
        ) : null}
        <button type="submit" className="refresh-button router-submit" disabled={busy || source !== "database" || !tasks.length}>{busy ? "Working…" : "Dispatch task"}</button>
      </form>
      {provider === "codex-cli" && codexStatus && !codexStatus.authenticated ? <p className="inline-message" role="status">{codexStatus.message}</p> : null}
      {source !== "database" ? <p className="inline-message">Connect PostgreSQL to run and save tasks.</p> : null}
      {message ? <p className="inline-message" role="status">{message}</p> : null}
      {prompt ? <div className="manual-handoff">
        <div className="panel-head">
          <div>
            <h3>Manual handoff: {providerLabels[activeProvider] ?? activeProvider}</h3>
            <p className="muted">Copy the prompt below to your service, or click the direct link to open it. Then paste the model response back to save it.</p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {providerExternalUrls[activeProvider] ? (
              <a
                href={providerExternalUrls[activeProvider]}
                target="_blank"
                rel="noopener noreferrer"
                className="refresh-button"
                style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              >
                Open {activeProvider === "chatgpt-free" ? "ChatGPT" : activeProvider === "claude-free" ? "Claude" : "Codex"} ↗
              </a>
            ) : null}
            <button type="button" className="refresh-button" onClick={copyPromptToClipboard}>
              {copiedPrompt ? "Copied!" : "Copy prompt"}
            </button>
          </div>
        </div>
        <textarea aria-label="Task prompt" readOnly value={prompt} rows={10} style={{ fontFamily: "monospace", fontSize: "0.85rem" }} />
        <form onSubmit={submitManualResult} style={{ marginTop: "1rem" }}>
          <label className="router-field">
            Paste the model response
            <textarea required maxLength={30000} value={manualOutput} onChange={(event) => setManualOutput(event.target.value)} placeholder="Paste the response JSON or text here for review, proposal verification, and storage." rows={6} />
          </label>
          <button type="submit" className="refresh-button" disabled={busy || !manualOutput.trim()}>{busy ? "Saving…" : "Save response & evaluate proposals"}</button>
        </form>
      </div> : null}
    </section>

    <section className="panel agent-run-history">
      <div className="panel-head">
        <div>
          <h2>Agent execution queue & history</h2>
          <p className="muted">Queued work is claimed by the agent worker: Codex CLI first, then local Ollama. This view refreshes automatically.</p>
          <div className={`worker-status ${workerStatus?.online ? "online" : "offline"}`}>
            <span />
            {workerStatus?.online ? `Worker online · Codex CLI ${workerStatus.details.codex_cli_authenticated ? "signed in" : "needs sign-in"}` : "Worker offline"}
            {workerStatus?.last_seen_at ? ` · last seen ${new Date(workerStatus.last_seen_at).toLocaleString()}` : ""}
          </div>
        </div>
        <div className="run-toolbar">
          <button
            type="button"
            className="refresh-button"
            onClick={() => void runNextQueued()}
            disabled={busy || source !== "database" || (!configured["codex-cli"] && !configured.ollama)}
          >
            {busy ? "Working…" : "Run next queued task"}
          </button>
          <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={busy}>Refresh</button>
        </div>
      </div>
      {authRequired ? <p className="queue-note">Enter the admin token above to view run history or start queued work.</p> : null}
      <section className="run-stats" aria-label="Agent run totals">
        <div><span>Queued</span><strong>{runCounts.queued ?? 0}</strong></div>
        <div><span>Running</span><strong>{runCounts.running ?? 0}</strong></div>
        <div><span>Completed</span><strong>{runCounts.completed ?? 0}</strong></div>
        <div><span>Failed</span><strong>{runCounts.failed ?? 0}</strong></div>
        <div><span>Awaiting handoff</span><strong>{runCounts.awaiting_external ?? 0}</strong></div>
        <div><span>Expired handoffs</span><strong>{runCounts.expired ?? 0}</strong></div>
        {configured.ollama && localCap && localCap.limit > 0 ? <div><span>Local runs (1h)</span><strong>{localCap.used}/{localCap.limit}{localCap.capped ? " · paused" : ""}</strong></div> : null}
      </section>
      {queueMessage ? <p className="inline-message" role="status">{queueMessage}</p> : null}
      <div className="subsection-title">Recent runs</div>
      {runs.length ? <div className="run-list">{runs.map((run) => <article className="run-item" key={run.id}>
        <div className="run-heading">
          <div>
            <strong>{run.task_title ?? "Deleted task"}</strong>
            <div className="muted">{run.agent_name ?? "Unassigned agent"} · {providerLabels[run.provider] ?? run.provider}{run.model && run.model !== "manual handoff" ? ` · ${run.model}` : ""}</div>
          </div>
          <span className={`run-status ${run.status}`}>{run.status.replaceAll("_", " ")}</span>
        </div>
        {run.error ? <p className="run-error">{run.error}</p> : null}
        {run.summary ? <p className="workflow-summary" style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>{run.summary}</p> : null}
        {run.status === "failed" && ["codex-cli", "ollama", "auto"].includes(run.provider) && !run.retry_run_id ? (
          <button type="button" className="refresh-button" onClick={() => void retryFailedRun(run)} disabled={busy} style={{ marginTop: "0.5rem" }}>
            {busy ? "Queueing…" : "Retry in queue"}
          </button>
        ) : null}
        {run.retry_run_id ? <p className="retry-note">Retry attempt: {run.retry_status?.replaceAll("_", " ") ?? "queued"}</p> : null}
        {run.status === "awaiting_external" ? (
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className="refresh-button" onClick={() => resumeHandoff(run)}>Resume handoff</button>
            {run.input?.prompt ? (
              <button type="button" className="refresh-button" onClick={() => void navigator.clipboard.writeText(run.input?.prompt ?? "")}>
                Copy prompt
              </button>
            ) : null}
            {providerExternalUrls[run.provider] ? (
              <a href={providerExternalUrls[run.provider]} target="_blank" rel="noopener noreferrer" className="refresh-button" style={{ textDecoration: "none" }}>
                Open {run.provider === "chatgpt-free" ? "ChatGPT" : run.provider === "claude-free" ? "Claude" : "Codex"} ↗
              </a>
            ) : null}
          </div>
        ) : null}
        {run.result?.text ? <details style={{ marginTop: "0.5rem" }}><summary>View saved response</summary><pre>{run.result.text}</pre></details> : null}
      </article>)}</div> : <div className="empty-state">No model runs yet. Choose an open task and provider to begin.</div>}
    </section>
  </>;
}
