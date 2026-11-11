import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Ask CompanyOS guards: the Overview panel talks only to /api/ask, the
// route is owner-gated and runs asks as background jobs (start + poll, so
// no request waits on a full CPU generation), and the RAG service token
// stays server-side in the integration adapter.

const read = (path: string) => readFileSync(path, "utf8");

test("the RAG adapter is server-side, bearer-authenticated, and never logs", () => {
  assert.ok(existsSync("lib/integrations/rag.ts"), "lib/integrations/rag.ts is missing");
  const adapter = read("lib/integrations/rag.ts");
  assert.match(adapter, /process\.env\.RAG_API_URL/, "adapter must read RAG_API_URL");
  assert.match(adapter, /process\.env\.RAG_SERVICE_TOKEN/, "adapter must read RAG_SERVICE_TOKEN");
  assert.match(adapter, /Authorization: `Bearer \$\{token\}`/, "adapter must send the service token as a bearer header");
  assert.match(adapter, /\$\{base\}\/ask\/jobs/, "adapter must start and poll the service ask-job endpoints");
  assert.match(adapter, /startRagAskJob/, "adapter must expose starting an ask job");
  assert.match(adapter, /getRagAskJob/, "adapter must expose polling an ask job");
  assert.match(adapter, /AbortSignal\.timeout/, "adapter must bound every service request");
  assert.doesNotMatch(adapter, /console\./, "adapter must never log (the token is in scope)");
});

test("the /api/ask route is owner-gated, validating, and job-based", () => {
  assert.ok(existsSync("app/api/ask/route.ts"), "app/api/ask/route.ts is missing");
  const route = read("app/api/ask/route.ts");
  assert.match(route, /x-companyos-owner-authenticated/, "route must accept the owner session header");
  assert.match(route, /COMPANYOS_ADMIN_TOKEN/, "route must accept the admin token outside the session");
  assert.match(route, /export async function POST/, "route must accept ask submissions");
  assert.match(route, /export async function GET/, "route must accept ask-job polling");
  assert.match(route, /startRagAskJob/, "POST must start a background ask job");
  assert.match(route, /getRagAskJob/, "GET must poll the background ask job");
  assert.match(route, /jobId/, "route must pass the job id between start and poll");
  assert.match(route, /2000/, "route must bound the question length");
  assert.match(route, /ragConfigured\(\)/, "route must check configuration before calling out");
  assert.match(route, /status: 503/, "unconfigured service must answer 503, not a stack trace");
  assert.match(route, /status: 502/, "upstream failure must answer 502");
});

test("the Overview renders the Ask panel and the panel only calls /api/ask", () => {
  const overview = read("components/LiveOverview.tsx");
  assert.match(overview, /AskCompanyOS/, "LiveOverview must render the Ask panel");

  assert.ok(existsSync("components/AskCompanyOS.tsx"), "components/AskCompanyOS.tsx is missing");
  const panel = read("components/AskCompanyOS.tsx");
  assert.match(panel, /fetch\("\/api\/ask"/, "panel must post to /api/ask");
  assert.match(panel, /pollForAnswer/, "panel must poll until the background answer is ready");
  assert.match(panel, /jobId/, "panel must poll by job id");
  assert.match(panel, /Sources/, "panel must show the answer's sources");
  assert.doesNotMatch(panel, /RAG_SERVICE_TOKEN/, "panel must never reference the service token");
});

test("env example and README document the integration", () => {
  const envExample = read(".env.example");
  assert.match(envExample, /^RAG_API_URL=/m, ".env.example must list RAG_API_URL");
  assert.match(envExample, /^RAG_SERVICE_TOKEN=/m, ".env.example must list RAG_SERVICE_TOKEN");

  const readme = read("README.md");
  assert.match(readme, /POST \/api\/ask/, "README API reference must include /api/ask");
});
