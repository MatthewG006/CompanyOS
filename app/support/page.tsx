import { DemoBanner } from "@/components/DemoBanner";
import { Topbar } from "@/components/Topbar";
import { databaseAvailable } from "@/lib/db";
import { SupportDesk } from "./SupportDesk";

export const dynamic = "force-dynamic";

export default async function SupportPage() {
  const source = (await databaseAvailable()) ? "database" : "demo";
  return <div className="page-wrap">
    <DemoBanner source={source} />
    <Topbar title="Support Desk" subtitle="Owner-managed internal support cases, project tasks, and status history." />
    <SupportDesk authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)} />
  </div>;
}
