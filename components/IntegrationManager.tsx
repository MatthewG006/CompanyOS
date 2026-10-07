"use client";

import { useState } from "react";
import type { IntegrationConnection } from "@/lib/types";
import { StatusDot } from "./StatusDot";

export function IntegrationManager({ integrations }: { integrations: IntegrationConnection[] }) {
  const [items, setItems] = useState(integrations);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function sync(integration = "all") {
    setBusy(integration);
    setMessage("");
    try {
      const response = await fetch("/api/integrations/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integration }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Sync failed.");
      const failed = result.results?.filter((item: { status: string }) => item.status === "failed") ?? [];
      setMessage(failed.length ? `Completed with ${failed.length} integration error(s).` : "Sync completed.");
      const next = await fetch("/api/integrations", { cache: "no-store" });
      if (next.ok) {
        const body = await next.json() as { integrations: IntegrationConnection[] };
        setItems(body.integrations);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setBusy(null);
    }
  }

  return <div className="integration-manager">
    <div className="integration-toolbar">
      <div>
        <strong>Local integration control</strong>
        <span>Connect or sync only the integrations you have configured. Secrets stay server-side.</span>
      </div>
      <button type="button" className="refresh-button" onClick={() => sync("all")} disabled={busy !== null}>{busy ? "Syncing…" : "Sync configured"}</button>
    </div>
    {message ? <div className="inline-message">{message}</div> : null}
    <div className="connection-grid">
      {items.map((item) => <div className="connection-card integration-card" key={item.id}>
        <StatusDot status={item.status} />
        <div className="integration-main"><strong>{item.name}</strong><span>{item.status.replaceAll("_", " ")} · {item.mode}</span>{item.last_error ? <em>{item.last_error}</em> : null}{item.last_sync_at ? <small>Last sync {new Date(item.last_sync_at).toLocaleString()}</small> : null}</div>
        <div className="integration-actions">
          {["Gmail", "Google Calendar"].includes(item.name) && item.status === "chat_connected" ? <a className="refresh-button" href="/api/integrations/google/start">Connect Google</a> : null}
          {["Gmail", "Google Calendar", "GitHub", "Proxmox", "Nextcloud"].includes(item.name) && item.status !== "chat_connected" ? <button type="button" className="refresh-button" onClick={() => sync(item.name)} disabled={busy !== null}>Sync</button> : null}
        </div>
      </div>)}
    </div>
  </div>;
}
