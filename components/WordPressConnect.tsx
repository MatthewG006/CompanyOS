"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminTokenField, useAdminToken } from "@/components/AdminToken";

type WordPressStatus = {
  configured: boolean;
  url?: string;
  username?: string;
  healthy?: boolean;
  message?: string;
  roles?: string[];
  is_admin?: boolean;
};

/**
 * Owner-facing connect form for the WordPress site. PR #39 shipped the
 * /api/integrations/wordpress endpoint (encrypted secret storage + health
 * check) but no screen called it, so the connection could never be made
 * from the app. This panel closes that gap: the owner pastes an admin
 * application password once, it is stored encrypted server-side, and the
 * health result (including the administrator check) shows here.
 */
export function WordPressConnect({ authRequired }: { authRequired: boolean }) {
  const { token: adminToken } = useAdminToken();
  const [status, setStatus] = useState<WordPressStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("https://www.skymountaingraphics.com");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const headers = {
    "Content-Type": "application/json",
    ...(adminToken ? { Authorization: `Bearer ${adminToken}`, "x-companyos-admin-token": adminToken } : {}),
  };

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/wordpress", { cache: "no-store", headers: adminToken ? { Authorization: `Bearer ${adminToken}`, "x-companyos-admin-token": adminToken } : {} });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not read the WordPress connection status.");
      setStatus(data as WordPressStatus);
      if (data.configured) {
        if (data.url) setUrl(data.url);
        if (data.username) setUsername(data.username);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not read the WordPress connection status.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  async function save() {
    if (!url.trim() || !username.trim() || !password.trim()) { setMessage("Site URL, username, and the application password are all required."); return; }
    setBusy(true); setMessage("");
    try {
      const res = await fetch("/api/integrations/wordpress", {
        method: "POST", headers,
        body: JSON.stringify({ url: url.trim(), username: username.trim(), application_password: password.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save the WordPress connection.");
      setPassword("");
      setEditing(false);
      setMessage("Saved encrypted. Checking the connection against the live site…");
      await loadStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the WordPress connection.");
    } finally { setBusy(false); }
  }

  const showForm = editing || (status !== null && !status.configured);

  return <div className="wp-connect">
    {authRequired ? <AdminTokenField /> : null}
    {status?.configured && !editing ? <div className="wp-connect-status">
      <div>
        <strong>{status.url}</strong>
        <span>Signed in as {status.username}{status.roles?.length ? ` · ${status.roles.join(", ")}` : ""}</span>
        <span>{status.healthy ? "Connection healthy." : status.message ?? "Connection check failed."}</span>
        {status.is_admin
          ? <span className="wp-connect-admin">Administrator confirmed — pages, media, menus and site settings are all in reach, proposed for your approval first.</span>
          : <span className="wp-connect-warn">This account is not an administrator, so menus and site-settings changes will refuse. Reconnect with an admin account.</span>}
      </div>
      <button type="button" className="refresh-button" onClick={() => setEditing(true)}>Update credentials</button>
    </div> : null}
    {status === null ? <p className="muted">Checking the WordPress connection…</p> : null}
    {showForm ? <div className="wp-connect-form">
      <div className="brand-kit-grid">
        <label className="router-field">Site URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.skymountaingraphics.com" maxLength={300} /></label>
        <label className="router-field">WordPress admin username<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Your admin username" maxLength={120} autoComplete="username" /></label>
        <label className="router-field">Application password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Created in WordPress under Users → Profile" maxLength={200} autoComplete="new-password" /></label>
      </div>
      <div className="brand-kit-actions">
        <button type="button" className="refresh-button" disabled={busy || (authRequired && !adminToken)} onClick={() => void save()}>{busy ? "Saving…" : "Save WordPress connection"}</button>
        {editing ? <button type="button" className="refresh-button" disabled={busy} onClick={() => { setEditing(false); setPassword(""); }}>Cancel</button> : null}
        <span className="muted">Create the password in WordPress under Users → Profile → Application Passwords (name it “CompanyOS”). It is shown once — paste it here right away. Stored encrypted; never shown again.</span>
      </div>
    </div> : null}
    {message ? <p className="inline-message" role="status">{message}</p> : null}
  </div>;
}
