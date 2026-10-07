import { StatusDot } from "@/components/StatusDot";
import { Topbar } from "@/components/Topbar";
import { IntegrationManager } from "@/components/IntegrationManager";
import { getDashboardData } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const data = await getDashboardData();
  return <div className="page-wrap"><Topbar title="Operations" subtitle="Control-room view of live services, integration readiness, sync history and external system records." />
    <section className="section-block"><div className="section-title-row"><div><h2>System checks</h2><p>Latest health records stored in the Company Brain.</p></div><div className="data-source">{data.system_checks.length} CHECKS</div></div>
      <div className="ops-grid">{data.system_checks.map((check) => <div className="ops-card" key={check.id}><div className="ops-head"><div><strong>{check.system_name}</strong><div className="muted">{check.project_name ?? "Company"}</div></div><StatusDot status={check.status} /></div><div className="ops-lines"><div><span>Status</span><b>{check.status}</b></div><div><span>Latency</span><b>{check.latency_ms == null ? "—" : `${check.latency_ms} ms`}</b></div><div><span>Checked</span><b>{new Date(check.checked_at).toLocaleString()}</b></div></div>{check.details ? <div className="ops-details">{check.details}</div> : null}</div>)}</div>
    </section>
    <section className="section-block"><div className="section-title-row"><div><h2>Integration control</h2><p>Server-side integrations are separate from your ChatGPT connections.</p></div></div><IntegrationManager integrations={data.integrations} /></section>
    <section className="section-block"><div className="section-title-row"><div><h2>Sync history</h2><p>Recent collector runs and errors.</p></div></div><div className="agent-table">{data.sync_runs.map((run) => <div className="agent-row sync-row" key={run.id}><div><strong>{run.integration_name}</strong><span>{new Date(run.started_at).toLocaleString()}</span></div><div><StatusDot status={run.status} /><span>{run.status}</span></div><div><strong>{run.records_written}</strong><span>records written</span></div><div><strong>{run.error ? "Error" : `${run.records_seen} seen`}</strong><span>{run.error ?? "completed"}</span></div></div>)}{data.sync_runs.length === 0 ? <div className="empty-state">No sync runs yet.</div> : null}</div></section>
    <section className="section-block"><div className="section-title-row"><div><h2>External records</h2><p>Normalized records from connected services.</p></div><div className="data-source">{data.external_summary.total} TOTAL</div></div><div className="connection-grid">{data.external_summary.by_provider.map((item) => <div className="connection-card" key={item.provider}><StatusDot status="healthy" /><div><strong>{item.provider}</strong><span>{item.count} records</span></div></div>)}</div></section>
  </div>;
}
