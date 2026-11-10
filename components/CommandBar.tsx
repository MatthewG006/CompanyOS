"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

export function CommandBar({ onCommandComplete }: { onCommandComplete?: () => void }) {
  const [command, setCommand] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K focuses the command bar from anywhere in the app.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
      if (onCommandComplete) onCommandComplete();
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
          ref={inputRef}
          aria-label="Company Brain command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Ask the Company Brain… e.g. 'Create task for Engineer: Update landing page hero' or 'Show me everything that needs my attention'"
        />
        <kbd className="command-kbd">⌘K</kbd>
        <button type="submit" disabled={busy}>{busy ? "Routing…" : "Run"}</button>
      </form>
      {response ? <div className="command-response">{response}</div> : null}
    </div>
  );
}
