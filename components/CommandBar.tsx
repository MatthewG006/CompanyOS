"use client";

import { type FormEvent, useState } from "react";

export function CommandBar() {
  const [command, setCommand] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!command.trim() || busy) return;
    setBusy(true);
    setResponse(null);
    try {
      const result = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const data = await result.json();
      setResponse(data.message ?? "Command accepted.");
      setCommand("");
    } catch {
      setResponse("The command service is not available yet.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="command-shell">
      <form onSubmit={submit} className="command-form">
        <div className="command-icon">⌘</div>
        <input
          aria-label="Company Brain command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Ask the Company Brain… e.g. Show me everything that needs my attention"
        />
        <button type="submit" disabled={busy}>{busy ? "Routing…" : "Run"}</button>
      </form>
      {response ? <div className="command-response">{response}</div> : null}
    </div>
  );
}
