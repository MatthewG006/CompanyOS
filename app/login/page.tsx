"use client";

import { useState, type FormEvent } from "react";

function safeDestination(value: string | null) {
  try {
    const target = new URL(value || "/", window.location.origin);
    return target.origin === window.location.origin ? `${target.pathname}${target.search}${target.hash}` : "/";
  } catch {
    return "/";
  }
}

export default function LoginPage() {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Sign-in failed.");
      window.location.assign(safeDestination(new URLSearchParams(window.location.search).get("next")));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="auth-screen">
    <div className="auth-card">
      <div className="brand-mark">SM</div>
      <p className="auth-eyebrow">SKY MOUNTAIN</p>
      <h1>CompanyOS</h1>
      <p className="auth-description">Sign in with the owner token configured on the CompanyOS server.</p>
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="owner-token">Owner token</label>
        <input id="owner-token" type="password" autoComplete="current-password" required value={token} onChange={(event) => setToken(event.target.value)} />
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        {message ? <p role="alert" className="auth-error">{message}</p> : null}
      </form>
      <p className="auth-footnote">Sessions expire after 12 hours. Keep this service on your private network.</p>
    </div>
  </section>;
}
