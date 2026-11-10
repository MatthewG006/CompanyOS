import { DemoBanner } from "@/components/DemoBanner";
import { Topbar } from "@/components/Topbar";
import { getAgencyData } from "@/lib/data";
import { AgencyDesk } from "./AgencyDesk";

export const dynamic = "force-dynamic";

export default async function AgencyPage() {
  const data = await getAgencyData();
  return <div className="page-wrap">
    <DemoBanner source={data.source} />
    <Topbar title="Agency" subtitle="Your departments, their live work, and one brand kit per business — you approve, they execute." />
    <AgencyDesk
      projects={data.projects}
      agents={data.agents}
      tasks={data.tasks}
      approvals={data.approvals}
      brandKits={data.brand_kits}
      authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)}
    />
  </div>;
}
