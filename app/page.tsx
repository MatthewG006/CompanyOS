import { getDashboardData } from "@/lib/data";
import { LiveOverview } from "@/components/LiveOverview";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const data = await getDashboardData();
  return <LiveOverview initial={data} />;
}
