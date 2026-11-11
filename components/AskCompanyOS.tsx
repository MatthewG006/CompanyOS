"use client";

import { type FormEvent, useEffect, useState } from "react";

type Citation = {
  source: string;
  external_id: string;
  title: string;
  chunk_index: number;
  score: number;
};

// The knowledge service generates answers on a local CPU model, which can
// take a minute or two. Asks therefore run as background jobs: POST starts
// one, then this panel polls until the answer is ready — no single request
// is held open long enough for a proxy to cut it off.
const POLL_INTERVAL_MS = 3000;
const POLL_DEADLINE_MS = 6 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollForAnswer(jobId: string): Promise<{ answer: string; citations: Citation[] }> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const result = await fetch(`/api/ask?jobId=${encodeURIComponent(jobId)}`);
    const data = await result.json();
    if (!result.ok) {
      throw new Error(data.error ?? "Ask CompanyOS is not available right now.");
    }
    if (data.status === "done") {
      return {
        answer: typeof data.answer === "string" ? data.answer : "",
        citations: Array.isArray(data.citations) ? data.citations : [],
      };
    }
  }
  throw new Error("Still thinking — the service is unusually slow right now. Try again in a moment.");
}

/**
 * Ask CompanyOS: questions answered by the RAG knowledge service from
 * indexed CompanyOS content (project memories, brand kits, support cases,
 * content), with the sources shown under the answer. The service token
 * stays on the server; this panel only talks to /api/ask.
 */
export function AskCompanyOS() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setAnswer(null);
    setCitations([]);
    setNotice(null);
    try {
      const started = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const startData = await started.json();
      if (!started.ok) {
        setNotice(startData.error ?? "Ask CompanyOS is not available right now.");
        return;
      }
      const result = await pollForAnswer(String(startData.jobId ?? ""));
      setAnswer(result.answer);
      setCitations(result.citations);
      setQuestion("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Ask CompanyOS is not available right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section-block">
      <div className="section-title-row">
        <div>
          <h2>Ask CompanyOS</h2>
          <p>Questions answered from your indexed business knowledge, with sources.</p>
        </div>
        <div className="data-source">COMPANY BRAIN · RAG</div>
      </div>
      <div className="panel">
        <form onSubmit={submit} className="command-form">
          <div className="command-icon">?</div>
          <input
            aria-label="Ask CompanyOS a question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask anything… e.g. 'What services does Sky Mountain Graphics offer?'"
            disabled={busy}
          />
          <button type="submit" disabled={busy}>{busy ? "Thinking…" : "Ask"}</button>
        </form>
        {busy ? (
          <div className="muted" style={{ marginTop: 8 }}>
            Thinking… {elapsed}s — the local model can take a minute or two; this panel keeps checking until the answer is ready.
          </div>
        ) : null}
        {notice ? <div className="command-response">{notice}</div> : null}
        {answer ? <div className="command-response" style={{ whiteSpace: "pre-wrap" }}>{answer}</div> : null}
        {citations.length ? (
          <div className="subsection">
            <div className="subsection-title">Sources</div>
            <div className="list-stack">
              {citations.map((citation) => (
                <div className="list-item" key={`${citation.source}-${citation.external_id}-${citation.chunk_index}`}>
                  <div>
                    <strong>{citation.title || citation.source}</strong>
                    <div className="muted">{citation.source} · match {Math.round(citation.score * 100)}%</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
