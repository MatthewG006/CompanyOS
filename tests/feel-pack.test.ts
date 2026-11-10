import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Feel pack guards: route states, one shared admin token, one shared
// polling loop, an action-first Agents page, and navigation that shows
// where you are — with a CommandBar (and ⌘K) that exists on every page.

const read = (path: string) => readFileSync(path, "utf8");

test("root loading, error and not-found states exist and behave", () => {
  assert.ok(existsSync("app/loading.tsx"), "app/loading.tsx is missing");
  assert.ok(existsSync("app/error.tsx"), "app/error.tsx is missing");
  assert.ok(existsSync("app/not-found.tsx"), "app/not-found.tsx is missing");

  const loading = read("app/loading.tsx");
  assert.match(loading, /role="status"/, "loading state must announce itself");
  assert.match(loading, /skeleton/, "loading state should render skeletons, not a blank page");

  const error = read("app/error.tsx");
  assert.match(error, /^"use client";/m, "error boundary must be a client component");
  assert.match(error, /reset/, "error state must offer a retry via reset()");
  assert.match(error, /role="alert"/, "error state must be announced");

  const notFound = read("app/not-found.tsx");
  assert.match(notFound, /href="\/"/, "404 must link back to the Overview");
});

test("the admin token lives in one shared, session-persisted store", () => {
  const store = read("components/AdminToken.tsx");
  assert.match(store, /createContext/, "token store must be a React context");
  assert.match(store, /sessionStorage/, "token must persist in sessionStorage");
  assert.match(store, /companyos-admin-token/, "token storage key drifted");
  assert.match(store, /export function AdminTokenField/, "panels must render the shared field");

  const layout = read("app/layout.tsx");
  assert.match(layout, /AdminTokenProvider/, "the provider must wrap the app in the root layout");

  const panels = [
    "app/agents/AgentConsole.tsx",
    "app/agents/AgentPolicyEditor.tsx",
    "app/finance/FinanceLedger.tsx",
    "app/intelligence/WorkflowMonitor.tsx",
    "app/onboarding/OnboardingBoard.tsx",
    "app/projects/ProjectMemoryEditor.tsx",
    "app/sales/SalesPipeline.tsx",
    "app/support/SupportDesk.tsx",
    "components/ApprovalList.tsx",
  ];
  for (const panel of panels) {
    const source = read(panel);
    assert.match(source, /useAdminToken\(\)/, `${panel} must read the shared token store`);
    assert.match(source, /<AdminTokenField/, `${panel} must render the shared token field`);
    assert.doesNotMatch(source, /Admin token<input/, `${panel} still renders its own private token input`);
    assert.doesNotMatch(source, /const \[(?:adminToken|token), set(?:AdminToken|Token)\] = useState\(""\)/, `${panel} still keeps a private token state`);
  }
});

test("live panels poll through the shared hook that pauses on hidden tabs", () => {
  const hook = read("components/usePolling.ts");
  assert.match(hook, /visibilitychange/, "polling must react to tab visibility");
  assert.match(hook, /document\.hidden/, "polling must skip hidden tabs");
  assert.match(hook, /runningRef/, "polling must guard against overlapping runs");

  const pollers = [
    "components/LiveOverview.tsx",
    "app/support/SupportDesk.tsx",
    "app/intelligence/WorkflowMonitor.tsx",
    "app/agents/AgentConsole.tsx",
  ];
  for (const poller of pollers) {
    const source = read(poller);
    assert.match(source, /usePolling\(/, `${poller} must poll via usePolling`);
    assert.doesNotMatch(source, /setInterval/, `${poller} still runs its own interval`);
  }
});

test("the Agents page leads with the console and the board stays live", () => {
  const page = read("app/agents/page.tsx");
  const consoleAt = page.indexOf("<AgentConsole");
  const tableAt = page.indexOf('className="agent-table"');
  const policiesAt = page.indexOf("<AgentPolicyEditor");
  assert.ok(consoleAt !== -1 && tableAt !== -1 && policiesAt !== -1, "agents page sections missing");
  assert.ok(consoleAt < tableAt, "the console (the doing) must come before the roster table");
  assert.ok(tableAt < policiesAt, "policies (rarely touched) must come last");

  const console_ = read("app/agents/AgentConsole.tsx");
  assert.match(console_, /fetch\("\/api\/tasks"/, "the task board must refetch tasks instead of trusting the page-load prop");
  assert.match(console_, /boardTasks/, "the task board must render from live state");
  assert.match(console_, /SHOWING 8 OF/, "the board must say when it shows only the first 8 tasks");
});

test("navigation shows the current page and the brand links home", () => {
  const sidebar = read("components/Sidebar.tsx");
  assert.match(sidebar, /^"use client";/m, "sidebar needs the pathname, so it must be a client component");
  assert.match(sidebar, /usePathname/, "sidebar must read the current pathname");
  assert.match(sidebar, /aria-current=\{active \? "page" : undefined\}/, "the active link must expose aria-current");
  assert.match(sidebar, /nav-link active/, "the active link must get the active style");
  assert.match(sidebar, /<Link href="\/" className="brand-block brand-link"/, "the brand block must link to the Overview");

  const css = read("app/globals.css");
  assert.match(css, /\.nav-link\.active/, "globals.css must style the active nav link");
});

test("the CommandBar is global and ⌘K really focuses it", () => {
  const layout = read("app/layout.tsx");
  assert.match(layout, /GlobalCommandBar/, "the command bar must render from the root layout");

  const wrapper = read("components/GlobalCommandBar.tsx");
  assert.match(wrapper, /pathname === "\/login"/, "the command bar must stay off the sign-in page");

  const bar = read("components/CommandBar.tsx");
  assert.match(bar, /metaKey \|\| event\.ctrlKey/, "⌘K handler must cover macOS and Windows/Linux");
  assert.match(bar, /event\.key\.toLowerCase\(\) === "k"/, "⌘K handler must listen for K");
  assert.match(bar, /inputRef\.current\?\.focus\(\)/, "⌘K must focus the command input");
  assert.match(bar, /command-kbd/, "the ⌘K hint must be visible in the bar");

  const overview = read("components/LiveOverview.tsx");
  assert.doesNotMatch(overview, /CommandBar/, "the Overview must not render a second, local command bar");
});
