import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// Trust-pack regression guards (source-level, in the style of the worker
// parity tests): demo data must never pose as real data, the Overview
// approvals list must follow the 30s poll, and client workspaces must not
// flash their "empty" copy before the first fetch settles.

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("DemoBanner renders only in demo mode and is an alert", async () => {
  const banner = await read("components/DemoBanner.tsx");
  assert.match(banner, /source !== "demo"\) return null/);
  assert.match(banner, /role="alert"/);
  assert.match(banner, /Demo data/);
});

test("every data page renders the DemoBanner", async () => {
  const bannerPages = [
    "components/LiveOverview.tsx", // Overview (app/page.tsx renders LiveOverview)
    "app/agents/page.tsx",
    "app/communications/page.tsx",
    "app/finance/page.tsx",
    "app/intelligence/page.tsx",
    "app/onboarding/page.tsx",
    "app/operations/page.tsx",
    "app/projects/page.tsx",
    "app/sales/page.tsx",
    "app/settings/page.tsx",
    "app/support/page.tsx",
  ];
  for (const page of bannerPages) {
    assert.match(await read(page), /<DemoBanner source=\{/, `${page} must render DemoBanner`);
  }
});

test("ApprovalList syncs to freshly polled approvals, except mid-decision", async () => {
  const list = await read("components/ApprovalList.tsx");
  assert.match(list, /useEffect\(\(\) => \{\s*if \(busy !== null\) return;\s*setItems\(initial\);/);
});

test("client workspaces gate their empty states on a loaded flag", async () => {
  const gatedWorkspaces = [
    "app/support/SupportDesk.tsx",
    "app/sales/SalesPipeline.tsx",
    "app/finance/FinanceLedger.tsx",
    "app/onboarding/OnboardingBoard.tsx",
    "app/projects/ProjectMemoryEditor.tsx",
  ];
  for (const file of gatedWorkspaces) {
    const source = await read(file);
    assert.match(source, /const \[loaded, setLoaded\] = useState\(false\)/, `${file} must track a loaded flag`);
    assert.match(source, /setLoaded\(true\)/, `${file} must set loaded when its fetch settles`);
    assert.match(source, /Loading/, `${file} must show a loading state before the first fetch settles`);
  }
});
