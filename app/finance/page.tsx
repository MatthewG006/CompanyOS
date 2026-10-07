import { MetricCard } from "@/components/MetricCard";
import { Topbar } from "@/components/Topbar";
import { getDashboardData } from "@/lib/data";
import { FinanceLedger } from "./FinanceLedger";

export const dynamic = "force-dynamic";
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export default async function FinancePage() {
  const { finance, source } = await getDashboardData();
  return <div className="page-wrap"><Topbar title="Finance" subtitle="Month-to-date finance metrics and owner-managed transaction ledger." /><div className="data-source finance-source">SOURCE: {source.toUpperCase()}</div><div className="metric-grid"><MetricCard label="Revenue" value={money(finance.revenue_cents)} detail="Month to date" /><MetricCard label="Expenses" value={money(finance.expenses_cents)} detail="Month to date" /><MetricCard label="AI cost" value={money(finance.ai_cost_cents)} detail="Recorded inference cost" /><MetricCard label="Operating result" value={money(finance.profit_cents)} detail="Revenue minus expenses" /></div><div className="panel finance-ai-note"><div className="panel-head"><h2>AI cost tracking</h2><span>Recorded usage</span></div><p className="panel-copy">AI cost totals include values recorded in the Company Brain. Provider usage is not yet imported automatically, and this screen does not enforce a spending budget.</p></div><FinanceLedger authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)} /></div>;
}
