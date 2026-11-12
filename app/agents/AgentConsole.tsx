"use client";

import { useCallback, useEffect, useState } from "react";
import { ListSearch, matchesQuery } from "@/components/ListSearch";
import { usePolling } from "@/components/usePolling";
import { AdminTokenField, useAdminToken } from "@/components/AdminToken";
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
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runQuery, setRunQuery] = useState("");
  const filteredRuns = runs.filter((run) => matchesQuery(runQuery, run.task_title, run.agent_name, run.provider, run.status, run.summary, run.error));
  const [runCounts, setRunCounts] = useState<RunCounts>({});
  const [workerStatus, setWorkerStatus] = useState<AgentWorkerStatus | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const { token: adminToken, setToken: setAdminToken } = useAdminToken();
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

  const [boardTasks, setBoardTasks] = useState<Task[]>(tasks);

  const refreshTasks = useCallback(async () => {
    try {
      const response = await fetch("/api/tasks", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json();
      if (Array.isArray(body.tasks)) setBoardTasks(body.tasks as Task[]);
    } catch {
      // Keep the last known list; the next refresh retries.
    }
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/agent-runs", { headers: requestHeaders(), cache: "no-store" });
    const body = await response.json();
    if (response.status === 401) {
      setAuthRequired(true);
      return;
    }
    if (!response.ok) throw new Error(body.error ?? "Could not load agent runs.");
    setAuthRequired(Boolean(body.auth_required));
    setWorkerStatus(body.agent_worker ?? null);
    setRuns(body.runs ?? []);
    setRunCounts(body.run_counts ?? {});
    await refreshTasks();
  }, [requestHeaders, refreshTasks]);

  useEffect(() => {
    void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not load agent runs."));
  }, [refresh]);

  usePolling(refresh, 8000);

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
    setActiveProvider(run.provider);
    setMessage(`This manual handoff (${providerLabels[run.provider] ?? run.provider}) is awaiting a response. Continue with the saved prompt below.`);
  }

  function copyPromptToClipboard() {
    if (!prompt) return;
    void navigator.clipboard.writeText(prompt);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2500);
  }

  async function markTaskComplete(targetTaskId: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/tasks", {
        method: "PATCH",
        headers: requestHeaders(),
        body: JSON.stringify({ id: targetTaskId, status: "completed" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not update task status.");
      setMessage(`Task marked as completed: ${body.task?.title ?? targetTaskId}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update task status.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    {boardTasks.length > 0 ? (
      <section className="panel task-board-panel" style={{ marginBottom: "1.5rem" }}>
        <div className="panel-head">
          <div>
            <h2>Open tasks</h2>
            <p className="muted">Tasks are worked autonomously: when a task is created or approved, it is queued for its agent and the Codex CLI worker picks it up. No dispatch step.</p>
          </div>
          <span className="data-source">{boardTasks.length > 8 ? `SHOWING 8 OF ${boardTasks.length} OPEN TASKS` : `${boardTasks.length} OPEN TASKS`}</span>
        </div>
        <div className="list-stack">
          {boardTasks.slice(0, 8).map((task) => (
            <div className="list-item task-board-item" key={task.id}>
              <div className="task-board-main">
                <div className="task-board-title">
                  <span className={`priority-badge ${task.priority}`}>{task.priority}</span>
                  <strong>{task.title}</strong>
                </div>
                <div className="muted task-board-meta">
                  {task.project_name ?? "Company-wide"} · Assigned: {task.agent_name ?? "Unassigned"} · Status: {task.status}
                </div>
              </div>
              <div className="task-board-actions">
                <button
                  type="button"
                  className="refresh-button"
                  style={{ fontSize: "0.85rem", whiteSpace: "nowrap", opacity: 0.8 }}
                  onClick={() => markTaskComplete(task.id)}
                  title="Mark task as completed"
                >
                  Mark done ✓
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    ) : null}

    {authRequired || message ? (
      <section className="panel agent-run-panel">
        {authRequired ? <AdminTokenField /> : null}
        {message ? <p className="inline-message" role="status">{message}</p> : null}
      </section>
    ) : null}

    {prompt ? (
      <section className="panel manual-handoff-panel">
        <div className="manual-handoff">
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
        </div>
      </section>
    ) : null}

    <section className="panel agent-run-history">
      <div className="panel-head">
        <div>
          <h2>Agent execution queue & history</h2>
          <p className="muted">Every approved or newly created task is queued automatically and claimed by the Codex CLI worker — no dispatch step. This view refreshes automatically.</p>
          <div className={`worker-status ${workerStatus?.online ? "online" : "offline"}`}>
            <span />
            {workerStatus?.online ? `Worker online · Codex CLI ${workerStatus.details.codex_cli_authenticated ? "signed in" : "needs sign-in"}` : "Worker offline"}
            {workerStatus?.last_seen_at ? <span suppressHydrationWarning> · last seen {new Date(workerStatus.last_seen_at).toLocaleString()}</span> : ""}
          </div>
        </div>
        <div className="run-toolbar">
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
      </section>
      {queueMessage ? <p className="inline-message" role="status">{queueMessage}</p> : null}
      <div className="list-head-tools run-search-row"><div className="subsection-title">Recent runs</div><ListSearch value={runQuery} onChange={setRunQuery} placeholder="Search runs…" /></div>
      {filteredRuns.length ? <div className="run-list">{filteredRuns.map((run) => <article className="run-item" key={run.id}>
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
      </article>)}</div> : runs.length ? <div className="empty-state">No runs match your search.</div> : <div className="empty-state">No model runs yet. Choose an open task and provider to begin.</div>}
    </section>
  </>;
}
