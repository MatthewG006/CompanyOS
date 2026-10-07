"use client";

import { useState } from "react";
import type { AttentionItem } from "@/lib/types";

export function AttentionList({ items: initialItems }: { items: AttentionItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [busy, setBusy] = useState<string | null>(null);

  async function update(id: string, status: "dismissed" | "snoozed") {
    setBusy(id);
    try {
      const response = await fetch("/api/attention", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!response.ok) return;
      setItems((current) => current.filter((item) => item.id !== id));
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return <div className="empty-state">Nothing currently requires attention.</div>;
  return (
    <div className="list-stack">
      {items.map((item) => (
        <div className="attention-row" key={item.id}>
          <div className={`priority-badge ${item.priority}`}>{item.priority}</div>
          <div className="attention-main"><strong>{item.title}</strong><div className="muted">{item.project_name ?? item.source} · {item.contact_name ?? "No contact"}{item.due_at ? ` · ${new Date(item.due_at).toLocaleString()}` : ""}</div>{item.description ? <div className="muted">{item.description}</div> : null}</div>
          <div className="attention-actions"><button type="button" className="refresh-button" onClick={() => update(item.id, "snoozed")} disabled={busy === item.id}>Snooze</button><button type="button" className="refresh-button" onClick={() => update(item.id, "dismissed")} disabled={busy === item.id}>Dismiss</button></div>
        </div>
      ))}
    </div>
  );
}
