import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Structure pack guards: per-domain data loaders, one API error helper,
// and searchable long lists.

const read = (path: string) => readFileSync(path, "utf8");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

test("pages and narrow routes load only their domain slice", () => {
  const data = read("lib/data.ts");
  for (const loader of ["getProjectsData", "getAgentsData", "getTasksData", "getEventsData", "getApprovalsData", "getIntegrationsData", "getFinanceData", "getCommunicationsData", "getOperationsData", "getIntelligenceData"]) {
    assert.match(data, new RegExp(`export async function ${loader}\\(`), `lib/data.ts must export ${loader}`);
  }
  assert.match(data, /availabilityMemo/, "database availability must be memoized across a request's loaders");

  const narrow: Record<string, string> = {
    "app/agents/page.tsx": "getAgentsData",
    "app/projects/page.tsx": "getProjectsData",
    "app/sales/page.tsx": "getProjectsData",
    "app/communications/page.tsx": "getCommunicationsData",
    "app/intelligence/page.tsx": "getIntelligenceData",
    "app/operations/page.tsx": "getOperationsData",
    "app/settings/page.tsx": "getIntegrationsData",
    "app/finance/page.tsx": "getFinanceData",
    "app/api/approvals/route.ts": "getApprovalsData",
    "app/api/events/route.ts": "getEventsData",
    "app/api/integrations/route.ts": "getIntegrationsData",
    "app/api/tasks/route.ts": "getTasksData",
  };
  for (const [path, loader] of Object.entries(narrow)) {
    const source = read(path);
    assert.ok(source.includes(`${loader}()`), `${path} must load via ${loader}`);
    assert.doesNotMatch(source, /getDashboardData/, `${path} must not pull the full dashboard`);
  }

  // Only the genuinely wide consumers keep getDashboardData.
  for (const wide of ["app/page.tsx", "app/api/overview/route.ts", "app/api/command/route.ts"]) {
    assert.match(read(wide), /getDashboardData\(\)/, `${wide} should keep the full dashboard loader`);
  }
});

test("API errors go through the shared helper, not hand-rolled boilerplate", () => {
  const helper = read("lib/api-errors.ts");
  assert.match(helper, /export function apiError\(/, "api-errors must export apiError");
  assert.match(helper, /export function apiErrorFrom\(/, "api-errors must export apiErrorFrom");
  assert.match(helper, /export function databaseUnavailable\(/, "api-errors must export databaseUnavailable");

  let helperUses = 0;
  for (const file of routeFiles("app/api")) {
    const source = read(file);
    assert.doesNotMatch(source, /NextResponse\.json\(\{ error: "Database is unavailable\." \}, \{ status: 503 \}\)/, `${file} still hand-rolls the database-unavailable response`);
    assert.doesNotMatch(source, /NextResponse\.json\(\{ error: error instanceof Error \? error\.message :/, `${file} still hand-rolls the catch-tail error response`);
    helperUses += (source.match(/apiErrorFrom\(|databaseUnavailable\(\)/g) ?? []).length;
  }
  assert.ok(helperUses >= 50, `expected the helper to be used across the routes, found ${helperUses} uses`);
});

test("the long owner lists are searchable", () => {
  const lists: Record<string, string> = {
    "app/finance/FinanceLedger.tsx": "filteredEntries",
    "app/support/SupportDesk.tsx": "filteredCases",
    "app/sales/SalesPipeline.tsx": "filteredLeads",
    "app/agents/AgentConsole.tsx": "filteredRuns",
  };
  for (const [path, filtered] of Object.entries(lists)) {
    const source = read(path);
    assert.match(source, /<ListSearch /, `${path} must render the shared ListSearch input`);
    assert.match(source, new RegExp(`${filtered}\\.map\\(`), `${path} must render the filtered list`);
    assert.match(source, /match your search/, `${path} must say when a search matches nothing`);
  }

  const search = read("components/ListSearch.tsx");
  assert.match(search, /export function ListSearch/, "ListSearch component must exist");
  assert.match(search, /export function matchesQuery/, "matchesQuery helper must exist");
  assert.match(search, /type="search"/, "the input must be a real search input");
});
