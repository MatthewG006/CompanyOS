import { Topbar } from "@/components/Topbar";
import { SupportDesk } from "./SupportDesk";

export const dynamic = "force-dynamic";

export default function SupportPage() {
  return <div className="page-wrap">
    <Topbar title="Support Desk" subtitle="Owner-managed internal support cases, project tasks, and status history." />
    <SupportDesk authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)} />
  </div>;
}
