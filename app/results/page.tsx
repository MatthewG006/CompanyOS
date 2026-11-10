import { DemoBanner } from "@/components/DemoBanner";
import { Topbar } from "@/components/Topbar";
import { getResultsData } from "@/lib/data";
import { ResultsBoard } from "./ResultsBoard";

export const dynamic = "force-dynamic";

export default async function ResultsPage() {
  const data = await getResultsData();
  return <div className="page-wrap">
    <DemoBanner source={data.source} />
    <Topbar title="Results" subtitle="Your business, at a glance: leads in, how fast they were answered, quotes, wins, and content shipped." />
    <ResultsBoard projects={data.projects} leads={data.sales_leads} outcomes={data.lead_outcomes} contentItems={data.content_items} />
  </div>;
}
