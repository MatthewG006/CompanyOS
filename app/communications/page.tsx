import { Topbar } from "@/components/Topbar";
import { IntegrationManager } from "@/components/IntegrationManager";
import { StatusDot } from "@/components/StatusDot";
import { getDashboardData } from "@/lib/data";
import { googleEmailSendReady } from "@/lib/integrations/google";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function CommunicationsPage() {
  const data = await getDashboardData();
  const gmailRecords = data.external_records.filter((item) => item.record_type === "email");
  const calendarRecords = data.external_records.filter((item) => item.record_type === "calendar_event");
  const sendReady = await googleEmailSendReady();
  const postalReady = Boolean(process.env.COMPANYOS_POSTAL_ADDRESS?.trim());
  const outbound = await query<{ id: string; recipient: string; subject: string; status: string; attempt_count: number; last_error: string | null; created_at: string }>(
    `SELECT id,recipient,subject,status,attempt_count,last_error,created_at::text
     FROM outbound_messages ORDER BY created_at DESC LIMIT 12`,
  ).then((result) => result.rows).catch(() => []);
  return <div className="page-wrap">
    <Topbar title="Communications" subtitle="Business email and calendar context synchronized into the Company Brain." />
    <IntegrationManager integrations={data.integrations.filter((item) => ["Gmail", "Google Calendar"].includes(item.name))} />
    <div className="panel section-gap"><div className="panel-head"><div><h2>Sales email readiness</h2><p className="muted">The Sales agent only prepares a draft. Each exact message must be approved here before Gmail sends it.</p></div><span className="data-source">{sendReady && postalReady ? "READY" : "SETUP REQUIRED"}</span></div><div className="list-stack"><div className="list-item"><StatusDot status={sendReady ? "healthy" : "warning"} /><span>Gmail send permission {sendReady ? "granted" : "missing — reconnect Google to approve the Gmail send scope"}</span></div><div className="list-item"><StatusDot status={postalReady ? "healthy" : "warning"} /><span>Business postal address {postalReady ? "configured" : "missing — set COMPANYOS_POSTAL_ADDRESS in the CompanyOS server environment"}</span></div><p className="muted">Enable “Sales contacts and emails” memory and “Draft sales email” permission for the Sales agent under Agents. Email opt-outs suppress future drafts. WhatsApp consent can be recorded in Sales; WhatsApp sending still requires a connected Business Platform sender and approved templates.</p></div></div>
    <div className="panel section-gap"><div className="panel-head"><h2>Outbound delivery</h2><span>{outbound.length} recent</span></div><div className="list-stack">{outbound.map((item) => <div className="list-item" key={item.id}><StatusDot status={item.status === "sent" ? "healthy" : item.status === "failed" ? "critical" : item.status === "rejected" ? "info" : "warning"} /><div><strong>{item.subject || "WhatsApp message"}</strong><div className="muted">{item.recipient} · {item.status} · {item.attempt_count} attempt(s) · {new Date(item.created_at).toLocaleString()}</div>{item.last_error ? <div className="muted">{item.last_error}</div> : null}</div></div>)}{outbound.length === 0 ? <div className="empty-state">No outbound messages have been proposed.</div> : null}</div></div>
    <div className="two-col section-gap">
      <div className="panel"><div className="panel-head"><h2>Recent email</h2><span>{gmailRecords.length} stored</span></div><div className="list-stack">{gmailRecords.slice(0, 12).map((item) => <div className="list-item" key={item.id}><StatusDot status="info" /><div><strong>{item.title}</strong><div className="muted">{item.owner ?? "Unknown sender"} · {item.occurred_at ? new Date(item.occurred_at).toLocaleString() : "No date"}</div>{item.url ? <a className="mini-link" href={item.url} target="_blank" rel="noreferrer">Open Gmail</a> : null}</div></div>)}{gmailRecords.length === 0 ? <div className="empty-state">No Gmail records have been synchronized yet.</div> : null}</div></div>
      <div className="panel"><div className="panel-head"><h2>Calendar</h2><span>{calendarRecords.length} stored</span></div><div className="list-stack">{calendarRecords.slice(0, 12).map((item) => <div className="list-item" key={item.id}><StatusDot status="info" /><div><strong>{item.title}</strong><div className="muted">{item.occurred_at ? new Date(item.occurred_at).toLocaleString() : "No start"}</div>{item.url ? <a className="mini-link" href={item.url} target="_blank" rel="noreferrer">Open Calendar</a> : null}</div></div>)}{calendarRecords.length === 0 ? <div className="empty-state">No calendar events have been synchronized yet.</div> : null}</div></div>
    </div>
    <div className="panel"><div className="panel-head"><h2>Communication events</h2><span>Company Brain</span></div><div className="list-stack">{data.events.filter((event) => ["sales", "support", "billing", "communications", "calendar", "google"].includes(event.source)).map((event) => <div className="list-item" key={event.id}><StatusDot status={event.severity} /><div><strong>{event.title}</strong><div className="muted">{event.source} · {new Date(event.created_at).toLocaleString()}</div></div></div>)}</div></div>
  </div>;
}
