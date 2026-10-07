import pg from "pg";

const { Client } = pg;
const connectionString = process.env.DATABASE_URL ?? "postgres://companyos:companyos_dev_password@localhost:5432/companyos";

const client = new Client({ connectionString });
await client.connect();

await client.query("TRUNCATE sync_runs, attention_items, meetings, contacts, external_records, integration_secrets, agent_runs, command_runs, integration_connections, system_checks, financial_metrics, approvals, events, tasks, agents, projects, companies RESTART IDENTITY CASCADE;");

const companies = [
  ["Sky Mountain Cloud", "sky-mountain-cloud", "Private cloud storage and file services."],
  ["Plenty of Plants", "plenty-of-plants", "Plant-collecting game and PWA."],
  ["Sky Mountain Graphics", "sky-mountain-graphics", "Graphic design and web services."],
];

const companyIds = {};
for (const [name, slug, description] of companies) {
  const result = await client.query(
    "INSERT INTO companies (name, slug, description) VALUES ($1,$2,$3) RETURNING id",
    [name, slug, description]
  );
  companyIds[slug] = result.rows[0].id;
}

const projects = [
  [companyIds["sky-mountain-cloud"], "Sky Mountain Cloud", "sky-mountain-cloud", "Nextcloud service, billing, onboarding and infrastructure.", "healthy", "active", 35],
  [companyIds["plenty-of-plants"], "Plenty of Plants", "plenty-of-plants", "Game, Firebase, analytics and nursery partnerships.", "building", "active", 30],
  [companyIds["sky-mountain-graphics"], "Sky Mountain Graphics", "sky-mountain-graphics", "Graphic design, web design and local-business services.", "active", "active", 20],
];

const projectIds = {};
for (const row of projects) {
  const result = await client.query(
    "INSERT INTO projects (company_id,name,slug,description,health,stage,progress) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    row
  );
  projectIds[row[2]] = result.rows[0].id;
}

const agents = [
  ["CEO", "Chief Executive", "Executive", "agnostic", "idle", "Company goals, priorities and owner briefing."],
  ["COO", "Operations Manager", "Operations", "agnostic", "working", "Turns goals into workflows and escalations."],
  ["CTO", "Technology Lead", "Technology", "agnostic", "working", "Architecture, technical priorities and engineering routing."],
  ["Engineer", "Software Engineer", "Engineering", "agnostic", "idle", "Implementation, debugging and maintenance."],
  ["QA", "Quality & Security", "Engineering", "agnostic", "idle", "Testing, regression and security review."],
  ["DevOps", "Site Reliability", "Infrastructure", "agnostic", "working", "Monitoring, deployments, backups and incidents."],
  ["Sales", "Sales Manager", "Sales", "agnostic", "idle", "Prospecting, qualification and follow-up."],
  ["Marketing", "Marketing Manager", "Marketing", "agnostic", "idle", "Campaigns, content, partnerships and analytics."],
  ["Support", "Customer Success", "Customer", "agnostic", "idle", "Customer communication, onboarding and issue routing."],
  ["Finance", "Finance & Operations", "Finance", "agnostic", "idle", "Revenue, expenses, AI budget and operating metrics."],
  ["Research", "Research Analyst", "Intelligence", "agnostic", "idle", "Market, competitor and product research."],
];
const agentIds = {};
for (const row of agents) {
  const allowedActions = ["request_task_creation", "request_task_status_change", ...(row[0] === "Finance" ? ["request_financial_entry"] : []), ...(row[0] === "Sales" ? ["request_sales_lead"] : [])];
  const result = await client.query(
    "INSERT INTO agents (name,role,department,provider,status,description,allowed_actions,memory_scope) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING id",
    [...row, JSON.stringify(allowedActions), JSON.stringify(["project", "tasks", "systems"])]
  );
  agentIds[row[0]] = result.rows[0].id;
}

const reporting = [
  ["COO", "CEO"], ["CTO", "CEO"], ["Engineer", "CTO"], ["QA", "CTO"], ["DevOps", "CTO"],
  ["Sales", "COO"], ["Marketing", "COO"], ["Support", "COO"], ["Finance", "CEO"], ["Research", "CEO"],
];
for (const [agentName, managerName] of reporting) {
  await client.query("UPDATE agents child SET reports_to=manager.id FROM agents manager WHERE child.name=$1 AND manager.name=$2", [agentName, managerName]);
}
await client.query(`UPDATE agents manager SET allowed_actions=manager.allowed_actions || '["request_task_delegation"]'::jsonb
  WHERE manager.allowed_actions ? 'request_task_creation' AND EXISTS (SELECT 1 FROM agents child WHERE child.reports_to=manager.id)`);

const tasks = [
  [projectIds["sky-mountain-cloud"], agentIds.DevOps, "Define CompanyOS health-check integration for Nextcloud", "high", "todo"],
  [projectIds["sky-mountain-cloud"], agentIds.Engineer, "Document free vs premium account provisioning", "normal", "todo"],
  [projectIds["plenty-of-plants"], agentIds.Research, "Create first retention-analysis experiment brief", "normal", "in_progress"],
  [projectIds["sky-mountain-graphics"], agentIds.Sales, "Build local-business prospecting workflow", "high", "in_progress"],
];
for (const row of tasks) {
  await client.query(
    "INSERT INTO tasks (project_id,agent_id,title,priority,status) VALUES ($1,$2,$3,$4,$5)",
    row
  );
}

const events = [
  [companyIds["sky-mountain-cloud"], projectIds["sky-mountain-cloud"], "system", "health_check", "Sky Mountain Cloud health check passed", "info"],
  [companyIds["sky-mountain-graphics"], projectIds["sky-mountain-graphics"], "sales", "lead", "Prospecting workflow needs attention", "warning"],
  [companyIds["plenty-of-plants"], projectIds["plenty-of-plants"], "analytics", "experiment", "Retention experiment brief started", "info"],
];
for (const row of events) {
  await client.query(
    "INSERT INTO events (company_id,project_id,source,event_type,title,severity) VALUES ($1,$2,$3,$4,$5,$6)",
    row
  );
}

await client.query(
  "INSERT INTO approvals (project_id,requested_by,action,risk_level,reason) VALUES ($1,$2,$3,$4,$5)",
  [projectIds["sky-mountain-cloud"], "DevOps", "Connect production monitoring endpoint", "medium", "Required before autonomous health-check workflows can run.\n"]
);

for (const [slug, projectId] of Object.entries(projectIds)) {
  await client.query(
    "INSERT INTO system_checks (project_id,system_name,status,latency_ms,details) VALUES ($1,$2,$3,$4,$5)",
    [projectId, slug === "sky-mountain-cloud" ? "Nextcloud" : "Application", slug === "plenty-of-plants" ? "warning" : "healthy", slug === "sky-mountain-cloud" ? 88 : 142, "Starter seeded state"]
  );
}

for (const companyId of Object.values(companyIds)) {
  await client.query(
    "INSERT INTO financial_metrics (company_id,metric_date,revenue_cents,expenses_cents,ai_cost_cents) VALUES ($1,CURRENT_DATE,0,0,0)",
    [companyId]
  );
}

const integrations = [
  ["Gmail", "google", "communications", "chat_connected", "external", "ChatGPT Gmail access is separate; local CompanyOS OAuth is ready when Google credentials are configured."],
  ["Google Calendar", "google", "scheduling", "chat_connected", "external", "ChatGPT Calendar access is separate; local CompanyOS OAuth is ready when Google credentials are configured."],
  ["GitHub", "github", "engineering", "planned", "local", "Connect when GitHub access is configured for CompanyOS."],
  ["Proxmox", "proxmox", "infrastructure", "planned", "local", "Configure a Proxmox API token for node health collection."],
  ["Nextcloud", "nextcloud", "storage", "planned", "local", "Configure NEXTCLOUD_URL for Sky Mountain Cloud health checks."],
  ["Firebase / Analytics", "firebase", "analytics", "planned", "webhook", "Forward approved Firebase analytics through n8n or the signed CompanyOS event endpoint."],
  ["n8n", "n8n", "automation", "planned", "webhook", "Send signed events into CompanyOS from n8n workflows."],
];
for (const row of integrations) {
  await client.query(
    "INSERT INTO integration_connections (name,provider,kind,status,mode,description) VALUES ($1,$2,$3,$4,$5,$6)",
    row
  );
}

console.log("CompanyOS seed complete.");
await client.end();
