import { DemoBanner } from "@/components/DemoBanner";
import { Topbar } from "@/components/Topbar";
import { databaseAvailable } from "@/lib/db";
import { OnboardingBoard } from "./OnboardingBoard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const source = (await databaseAvailable()) ? "database" : "demo";
  return <div className="page-wrap">
    <DemoBanner source={source} />
    <Topbar title="Customer Onboarding" subtitle="Internal onboarding checklists begin when an opportunity is marked Won. External messages and account changes remain owner-controlled." />
    <OnboardingBoard authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)} />
  </div>;
}
