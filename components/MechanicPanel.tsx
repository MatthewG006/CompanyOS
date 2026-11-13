"use client";

import { useEffect, useState } from "react";

type Diagnosis = {
  summary: string;
  likely_cause: string;
  recommended_action: string;
  commit: string | null;
  rationale: string;
};

// Diagnoses run as background jobs on the mechanic service (the RAG
// host's LLM — a different engine from the Codex worker, so it stays
// alive exactly when the worker cannot start). POST gathers the
// worker-health evidence and starts a job; this panel polls until the
// diagnosis is ready. If the diagnosis recommends an allowlisted runtime
// repair, the server records it as an owner approval — nothing executes
// from this panel.
const POLL_INTERVAL_MS = 3000;
const POLL_DEADLINE_MS = 6 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ACTION_LABELS: Record<string, string> = {
  restart_worker: "Restart the Codex worker",
  update_worker: "Update the Codex worker to the latest main",
  rollback_worker: "Roll the Codex worker back to a known-good commit",
  code_fix: "Needs a code fix (pull request + your merge) — no runtime repair proposed",
  none: "No repair needed",
};

async function pollForDiagnosis(
  jobId: string,
): Promise<{ diagnosis: Diagnosis; approvalId: string | null }> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const result = await fetch(`/api/mechanic?jobId=${encodeURIComponent(jobId)}`);
    const data = await result.json();
    if (!result.ok) {
      throw new Error(data.error ?? "The mechanic is not available right now.");
    }
    if (data.status === "done") {
      return {
        diagnosis: data.diagnosis as Diagnosis,
        approvalId: typeof data.approvalId === "string" ? data.approvalId : null,
      };
    }
  }
  throw new Error("Still diagnosing — the local model is unusually slow right now. Try again in a moment.");
}

export function MechanicPanel() {
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  async function runDiagnosis() {
    if (busy) return;
    setBusy(true);
    setDiagnosis(null);
    setApprovalId(null);
    setNotice(null);
    try {
      const started = await fetch("/api/mechanic", { method: "POST" });
      const startData = await started.json();
      if (!started.ok) {
        setNotice(startData.error ?? "The mechanic is not available right now.");
        return;
      }
      const result = await pollForDiagnosis(String(startData.jobId ?? ""));
      setDiagnosis(result.diagnosis);
      setApprovalId(result.approvalId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The mechanic is not available right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section-block">
      <div className="section-title-row">
        <div>
          <h2>Mechanic</h2>
          <p>A second opinion on a different engine: Llama reads the worker&apos;s heartbeat and recent failures, then proposes a repair.</p>
        </div>
        <div className="data-source">WORKER HEALTH · LLAMA</div>
      </div>
      <div className="panel">
        <div className="command-form">
          <div className="command-icon">✚</div>
          <div className="muted" style={{ flex: 1 }}>
            Most useful when the Codex:worker-health check is red. Repairs only ever happen through your approvals — a code fault comes back as a diagnosis, never a silent change.
          </div>
          <button type="button" onClick={runDiagnosis} disabled={busy}>{busy ? "Diagnosing…" : "Run diagnosis"}</button>
        </div>
        {busy ? (
          <div className="muted" style={{ marginTop: 8 }}>
            Diagnosing… {elapsed}s — the local model can take a minute or two; this panel keeps checking until the diagnosis is ready.
          </div>
        ) : null}
        {notice ? <div className="command-response">{notice}</div> : null}
        {diagnosis ? (
          <div className="command-response" style={{ whiteSpace: "pre-wrap" }}>
            {diagnosis.summary}
            {"\n"}Likely cause: {diagnosis.likely_cause}
            {"\n"}Recommendation: {ACTION_LABELS[diagnosis.recommended_action] ?? diagnosis.recommended_action}
            {diagnosis.recommended_action === "rollback_worker" && diagnosis.commit ? ` (${diagnosis.commit})` : ""}
            {"\n"}{diagnosis.rationale}
            {approvalId ? "\nA repair proposal is waiting in your approvals — nothing runs until you approve it." : ""}
          </div>
        ) : null}
      </div>
    </section>
  );
}
