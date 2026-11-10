import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("lead outcomes are logged and first response is timed", () => {
  const schema = read("../db/schema.sql");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS lead_outcomes/);
  assert.match(schema, /outcome TEXT NOT NULL CHECK \(outcome IN \('contacted','visit','quote','won','lost'\)\)/);
  assert.match(schema, /ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS first_contacted_at TIMESTAMPTZ/);
  // Phase 2 follow-through: existing databases grant Marketing the content
  // permission automatically at migrate time, like the earlier grants.
  assert.match(schema, /\|\| '\["request_content_item"\]'::jsonb[\s\S]*?LOWER\(name\)='marketing'/);
});

test("the outcomes endpoint advances stages forward only and starts onboarding on won", () => {
  const route = read("../app/api/sales/outcomes/route.ts");
  assert.match(route, /function stageForOutcome/);
  assert.match(route, /INSERT INTO lead_outcomes \(lead_id,outcome,note\)/);
  assert.match(route, /startOnboardingForWonLead/);
  assert.match(route, /lead_outcome_recorded/);
});

test("won-lead onboarding is shared by the pipeline PATCH and outcomes", () => {
  const helper = read("../lib/sales/onboarding.ts");
  assert.match(helper, /export async function startOnboardingForWonLead/);
  assert.match(helper, /queueTaskExecution/);
  const leads = read("../app/api/sales/leads/route.ts");
  assert.match(leads, /startOnboardingForWonLead\(client, lead\)/);
  assert.doesNotMatch(leads, /onboardingChecklist/);
});

test("new leads get a first-response task queued for the Sales agent", () => {
  const helper = read("../lib/ai/first-response.ts");
  assert.match(helper, /export async function queueFirstResponse/);
  assert.match(helper, /LOWER\(name\)='sales'/);
  assert.match(helper, /source: "new_lead_first_response"/);
  const leads = read("../app/api/sales/leads/route.ts");
  assert.match(leads, /if \(stage === "new"\) \{\s*await queueFirstResponse/);
  const registry = read("../lib/ai/tool-registry.ts");
  assert.match(registry, /await queueFirstResponse\(client, \{ projectId, leadId: result\.rows\[0\]\.id/);
});

test("the results loader composes leads, outcomes and content per business", () => {
  const data = read("../lib/data.ts");
  assert.match(data, /async function sliceSalesLeads/);
  assert.match(data, /async function sliceLeadOutcomes/);
  assert.match(data, /export async function getResultsData\(\) \{[\s\S]*?sliceSalesLeads\(\)[\s\S]*?sliceLeadOutcomes\(\)/);
  const demo = data.slice(data.indexOf("export const demoSalesLeads"), data.indexOf("const demoContacts"));
  assert.match(demo, /first_contacted_at: hoursAgo\(49\.93\)/);
});

test("the pipeline offers one-tap outcomes and shows first response time", () => {
  const pipeline = read("../app/sales/SalesPipeline.tsx");
  for (const label of ["Contacted", "Visit", "Quote", "Won", "Lost"]) {
    assert.match(pipeline, new RegExp(`label: "${label}"`));
  }
  assert.match(pipeline, /fetch\("\/api\/sales\/outcomes"/);
  assert.match(pipeline, /firstResponseLabel/);
});

test("the results page shows the KPI roll-up with a business switcher", () => {
  const page = read("../app/results/page.tsx");
  assert.match(page, /getResultsData/);
  const board = read("../app/results/ResultsBoard.tsx");
  assert.match(board, /Median first response/);
  assert.match(board, /Leads received · 30 days/);
  assert.match(board, /Latest outcomes/);
  assert.match(board, /All businesses/);
  const sidebar = read("../components/Sidebar.tsx");
  assert.match(sidebar, /\["Results", "\/results"\]/);
});
