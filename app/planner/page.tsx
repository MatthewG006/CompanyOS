import { DemoBanner } from "@/components/DemoBanner";
import { Topbar } from "@/components/Topbar";
import { getContentData } from "@/lib/data";
import { PlannerBoard } from "./PlannerBoard";

export const dynamic = "force-dynamic";

function mondayOf(date: Date): string {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

export default async function PlannerPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const data = await getContentData();
  const { week } = await searchParams;
  const weekStart = week && /^\d{4}-\d{2}-\d{2}$/.test(week) && !Number.isNaN(new Date(`${week}T12:00:00`).getTime())
    ? mondayOf(new Date(`${week}T12:00:00`))
    : mondayOf(new Date());
  return <div className="page-wrap">
    <DemoBanner source={data.source} />
    <Topbar title="Content Planner" subtitle="A week of posts, reels and stories per business — your agents draft, you approve, it publishes." />
    <PlannerBoard
      projects={data.projects}
      brandKits={data.brand_kits}
      items={data.content_items}
      weekStart={weekStart}
      authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)}
    />
  </div>;
}
