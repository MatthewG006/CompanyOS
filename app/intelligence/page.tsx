import { Topbar } from "@/components/Topbar";
import { StatusDot } from "@/components/StatusDot";
import { AttentionList } from "@/components/AttentionList";
import { getDashboardData } from "@/lib/data";
import { WorkflowMonitor } from "./WorkflowMonitor";

export const dynamic = "force-dynamic";

export default async function IntelligencePage() {
  const data = await getDashboardData();
  return (
    <div className="page-wrap">
      <Topbar title="Business Intelligence" subtitle="Contacts, upcoming meetings and actionable attention derived from the Company Brain." />
      <section className="section-block"><WorkflowMonitor /></section>
      <section className="section-block">
        <div className="section-title-row"><div><h2>Needs attention</h2><p>Deterministic first-pass triage from synchronized records. AI review can be added later.</p></div><div className="data-source">{data.attention_items.length} OPEN</div></div>
        <div className="panel"><AttentionList items={data.attention_items} /></div>
      </section>
      <section className="two-col">
        <div className="panel"><div className="panel-head"><h2>Contacts</h2><span>{data.contacts.length} cached</span></div><div className="list-stack">{data.contacts.slice(0, 15).map((contact) => <div className="list-item" key={contact.id}><StatusDot status={contact.status} /><div><strong>{contact.name ?? contact.email ?? "Unknown contact"}</strong><div className="muted">{contact.email ?? "No email"} · {contact.organization ?? "No organization"} · {contact.project_name ?? "Unassigned"}</div></div></div>)}{data.contacts.length === 0 ? <div className="empty-state">No contacts have been normalized yet.</div> : null}</div></div>
        <div className="panel"><div className="panel-head"><h2>Upcoming meetings</h2><span>{data.meetings.length} cached</span></div><div className="list-stack">{data.meetings.filter((meeting) => !meeting.start_at || new Date(meeting.start_at).getTime() >= Date.now()).slice(0, 15).map((meeting) => <div className="list-item" key={meeting.id}><StatusDot status="info" /><div><strong>{meeting.title}</strong><div className="muted">{meeting.start_at ? new Date(meeting.start_at).toLocaleString() : "No start"} · {meeting.organizer ?? "Unknown organizer"} · {meeting.project_name ?? "Company"}</div>{meeting.url ? <a className="mini-link" href={meeting.url} target="_blank" rel="noreferrer">Open event</a> : null}</div></div>)}{data.meetings.length === 0 ? <div className="empty-state">No calendar meetings have been synchronized yet.</div> : null}</div></div>
      </section>
    </div>
  );
}
