"use client";

import { useState } from "react";
import type { Approval } from "@/lib/types";
import { StatusDot } from "./StatusDot";

export function ApprovalList({ initial }: { initial: Approval[] }) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [adminToken, setAdminToken] = useState("");

  async function decide(id: string, status: "approved" | "rejected") {
    setBusy(id);
    setMessage(null);
    try {
      const response = await fetch("/api/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) },
        body: JSON.stringify({ id, status }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (response.status === 401) setAuthRequired(true);
        throw new Error(payload.error ?? "Unable to update approval.");
      }
      setItems((current) => current.filter((item) => item.id !== id));
      setMessage(payload.outbound_message_id ? "Approved. The exact email draft was added to the outbound queue." : payload.support_case_id ? "Approved. The Support case and linked task were updated." : payload.financial_transaction_id ? "Approved. The sales income was added to the Finance ledger." : payload.sales_lead_id ? "Approved. The lead was added to the Sales pipeline." : payload.affected_task_id ? "Approved. The task record was updated." : `Approval ${status}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update approval.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {authRequired ? <label className="router-field">Admin token<input type="password" autoComplete="current-password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
      {items.length === 0 ? <div className="empty-state">Nothing is waiting for owner approval.</div> : null}
      <div className="list-stack">
        {items.map((item) => (
          <div className="approval-item" key={item.id}>
            <div className="approval-main">
              <StatusDot status="pending" />
              <div>
                <strong>{item.action}</strong>
                <div className="muted">{item.project_name ?? "Company"} · {item.requested_by} · {item.risk_level} risk</div>
                {item.reason ? <div className="approval-reason">{item.reason}</div> : null}
                {item.action_type === "send_email" && item.payload ? <div className="approval-email-preview"><div><strong>To:</strong> {String(item.payload.to ?? "")}</div><div><strong>Subject:</strong> {String(item.payload.subject ?? "")}</div><pre>{String(item.payload.body ?? "")}</pre></div> : null}
              </div>
            </div>
            <div className="approval-actions">
              <button type="button" onClick={() => decide(item.id, "approved")} disabled={busy === item.id}>{item.action_type === "send_email" ? "Approve + send email" : item.action_type === "create_task" || item.action_type === "delegate_task" ? "Approve + create task" : item.action_type === "set_task_status" ? "Approve + update task" : item.action_type === "record_income" ? "Approve + record income" : item.action_type === "create_sales_lead" ? "Approve + add lead" : "Approve"}</button>
              <button type="button" className="danger" onClick={() => decide(item.id, "rejected")} disabled={busy === item.id}>Reject</button>
            </div>
          </div>
        ))}
      </div>
      {message ? <div className="inline-message">{message}</div> : null}
    </div>
  );
}
