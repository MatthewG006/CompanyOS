import { Topbar } from "@/components/Topbar";
import { getDashboardData } from "@/lib/data";
import { SalesPipeline } from "./SalesPipeline";

export const dynamic = "force-dynamic";

export default async function SalesPage() {
  const data = await getDashboardData();
  return <div className="page-wrap">
    <Topbar title="Sales Pipeline" subtitle="Track opportunities across Sky Mountain Cloud, Plenty of Plants, and Sky Mountain Graphics." />
    <SalesPipeline projects={data.projects.map(({ id, name }) => ({ id, name }))} authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)} />
  </div>;
}
