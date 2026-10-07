import { Topbar } from "@/components/Topbar";
import { getDashboardData } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { integrations } = await getDashboardData();
  return <div className="page-wrap"><Topbar title="Settings" subtitle="CompanyOS operating rules, data source boundaries and integration registry." /><div className="settings-list">
    <div className="setting-row"><div><strong>Operating mode</strong><span>Owner-supervised starter. No production writes are enabled by default.</span></div><b>SAFE</b></div>
    <div className="setting-row"><div><strong>AI provider</strong><span>Provider-neutral. ChatGPT and Claude are workers, not the system of record.</span></div><b>AGNOSTIC</b></div>
    <div className="setting-row"><div><strong>Company Brain</strong><span>PostgreSQL is the primary structured state store.</span></div><b>POSTGRES</b></div>
    <div className="setting-row"><div><strong>Command API</strong><span>Deterministic commands are allowed to read current state and create basic tasks.</span></div><b>LOCAL</b></div>
  </div><section className="section-block settings-section"><div className="section-title-row"><div><h2>Integration registry</h2><p>These records describe what CompanyOS can see or is preparing to connect.</p></div></div><div className="settings-list">{integrations.map((item) => <div className="setting-row" key={item.id}><div><strong>{item.name}</strong><span>{item.description}</span></div><b>{item.status.replaceAll("_", " ").toUpperCase()}</b></div>)}</div></section></div>;
}
