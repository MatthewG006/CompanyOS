import { Topbar } from "@/components/Topbar";
import { OnboardingBoard } from "./OnboardingBoard";

export const dynamic = "force-dynamic";

export default function OnboardingPage() {
  return <div className="page-wrap">
    <Topbar title="Customer Onboarding" subtitle="Internal onboarding checklists begin when an opportunity is marked Won. External messages and account changes remain owner-controlled." />
    <OnboardingBoard authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)} />
  </div>;
}
