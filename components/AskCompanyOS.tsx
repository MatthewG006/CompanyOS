"use client";

import { type FormEvent, useState } from "react";

type Citation = {
  source: string;
  external_id: string;
  title: string;
  chunk_index: number;
  score: number;
};

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setAnswer(null);
    setCitations([]);
    setNotice(null);
    try {
      const result = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await result.json();
      if (!result.ok) {
        setNotice(data.error ?? "Ask CompanyOS is not available right now.");
        return;
      }
      setAnswer(typeof data.answer === "string" ? data.answer : "");
      setCitations(Array.isArray(data.citations) ? data.citations : []);
      setQuestion("");
    } catch {
      setNotice("Ask CompanyOS is not available right now.");
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
          />
          <button type="submit" disabled={busy}>{busy ? "Thinking…" : "Ask"}</button>
        </form>
        {busy ? <div className="muted" style={{ marginTop: 8 }}>The local model can take a minute to answer.</div> : null}
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
