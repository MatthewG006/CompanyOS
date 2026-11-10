import { databaseAvailable, query } from "./db";
import type {
  Agent,
  Approval,
  AttentionItem,
  BrandKit,
  Contact,
  ContentItem,
  LeadOutcome,
  SalesLeadRow,
  DashboardData,
  EventItem,
  ExternalRecord,
  ExternalSummary,
  FinancialSnapshot,
  IntegrationConnection,
  Meeting,
  Project,
  SyncRun,
  SystemCheck,
  Task,
} from "./types";

export const demoProjects: Project[] = [
  { id: "demo-1", company_name: "Sky Mountain Cloud", name: "Sky Mountain Cloud", slug: "sky-mountain-cloud", description: "Nextcloud service, billing, onboarding and infrastructure.", health: "healthy", stage: "active", progress: 35, task_count: 2, open_task_count: 2 },
  { id: "demo-2", company_name: "Plenty of Plants", name: "Plenty of Plants", slug: "plenty-of-plants", description: "Game, Firebase, analytics and nursery partnerships.", health: "building", stage: "active", progress: 30, task_count: 1, open_task_count: 1 },
  { id: "demo-3", company_name: "Sky Mountain Graphics", name: "Sky Mountain Graphics", slug: "sky-mountain-graphics", description: "Graphic design, web design and local-business services.", health: "active", stage: "active", progress: 20, task_count: 1, open_task_count: 1 },
];

export const demoAgents: Agent[] = [
  { id: "a1", name: "CEO", role: "Chief Executive", department: "Executive", provider: "agnostic", status: "idle", description: "Company goals, priorities and owner briefing.", open_task_count: 0 },
  { id: "a2", name: "COO", role: "Operations Manager", department: "Operations", manager_name: "CEO", reports_to: "a1", provider: "agnostic", status: "working", description: "Turns goals into workflows and escalations.", open_task_count: 0 },
  { id: "a3", name: "CTO", role: "Technology Lead", department: "Technology", manager_name: "CEO", reports_to: "a1", provider: "agnostic", status: "working", description: "Architecture, technical priorities and engineering routing.", open_task_count: 0 },
  { id: "a4", name: "Engineer", role: "Software Engineer", department: "Engineering", manager_name: "CTO", reports_to: "a3", provider: "agnostic", status: "idle", description: "Implementation, debugging and maintenance.", open_task_count: 2 },
  { id: "a5", name: "QA", role: "Quality & Security", department: "Engineering", manager_name: "CTO", reports_to: "a3", provider: "agnostic", status: "idle", description: "Testing, regression and security review.", open_task_count: 0 },
  { id: "a6", name: "DevOps", role: "Site Reliability", department: "Infrastructure", manager_name: "CTO", reports_to: "a3", provider: "agnostic", status: "working", description: "Monitoring, deployments, backups and incidents.", open_task_count: 1 },
  { id: "a7", name: "Sales", role: "Sales Manager", department: "Sales", manager_name: "COO", reports_to: "a2", provider: "agnostic", status: "idle", description: "Prospecting, qualification and follow-up.", allowed_actions: ["request_task_creation", "request_task_status_change", "request_sales_lead"], open_task_count: 1 },
  { id: "a8", name: "Marketing", role: "Marketing Manager", department: "Marketing", manager_name: "COO", reports_to: "a2", provider: "agnostic", status: "idle", description: "Campaigns, content, partnerships and analytics.", allowed_actions: ["request_task_creation", "request_task_status_change", "request_content_item"], open_task_count: 0 },
  { id: "a9", name: "Support", role: "Customer Success", department: "Customer", manager_name: "COO", reports_to: "a2", provider: "agnostic", status: "idle", description: "Customer communication, onboarding and issue routing.", open_task_count: 0 },
  { id: "a10", name: "Finance", role: "Finance & Operations", department: "Finance", manager_name: "CEO", reports_to: "a1", provider: "agnostic", status: "idle", description: "Revenue, expenses, AI budget and operating metrics.", allowed_actions: ["request_task_creation", "request_task_status_change", "request_financial_entry"], open_task_count: 0 },
  { id: "a11", name: "Research", role: "Research Analyst", department: "Intelligence", manager_name: "CEO", reports_to: "a1", provider: "agnostic", status: "idle", description: "Market, competitor and product research.", open_task_count: 1 },
];

export const demoTasks: Task[] = [
  { id: "t1", project_name: "Sky Mountain Cloud", project_slug: "sky-mountain-cloud", agent_name: "DevOps", title: "Define CompanyOS health-check integration for Nextcloud", priority: "high", status: "todo" },
  { id: "t2", project_name: "Sky Mountain Cloud", project_slug: "sky-mountain-cloud", agent_name: "Engineer", title: "Document free vs premium account provisioning", priority: "normal", status: "todo" },
  { id: "t3", project_name: "Plenty of Plants", project_slug: "plenty-of-plants", agent_name: "Research", title: "Create first retention-analysis experiment brief", priority: "normal", status: "in_progress" },
  { id: "t4", project_name: "Sky Mountain Graphics", project_slug: "sky-mountain-graphics", agent_name: "Sales", title: "Build local-business prospecting workflow", priority: "high", status: "in_progress" },
];

export const demoEvents: EventItem[] = [
  { id: "e1", source: "system", event_type: "health_check", title: "Sky Mountain Cloud health check passed", severity: "info", created_at: new Date().toISOString(), project_name: "Sky Mountain Cloud" },
  { id: "e2", source: "sales", event_type: "lead", title: "Prospecting workflow needs attention", severity: "warning", created_at: new Date(Date.now() - 5 * 60_000).toISOString(), project_name: "Sky Mountain Graphics" },
  { id: "e3", source: "analytics", event_type: "experiment", title: "Retention experiment brief started", severity: "info", created_at: new Date(Date.now() - 45 * 60_000).toISOString(), project_name: "Plenty of Plants" },
];

export const demoApprovals: Approval[] = [
  { id: "p1", project_name: "Sky Mountain Cloud", requested_by: "DevOps", action: "Connect production monitoring endpoint", risk_level: "medium", reason: "Required before autonomous health-check workflows can run.", status: "pending" },
];

export const demoChecks: SystemCheck[] = [
  { id: "c1", project_name: "Sky Mountain Cloud", system_name: "Nextcloud", status: "healthy", latency_ms: 88, details: "Starter state", checked_at: new Date().toISOString() },
  { id: "c2", project_name: "Plenty of Plants", system_name: "Application", status: "warning", latency_ms: 142, details: "Starter state", checked_at: new Date().toISOString() },
  { id: "c3", project_name: "Sky Mountain Graphics", system_name: "Website", status: "healthy", latency_ms: 120, details: "Starter state", checked_at: new Date().toISOString() },
];

export const demoIntegrations: IntegrationConnection[] = [
  { id: "i1", name: "Gmail", provider: "google", kind: "communications", status: "chat_connected", mode: "external", last_sync_at: null, last_error: null, description: "ChatGPT connection is available; local CompanyOS OAuth is ready but not configured." },
  { id: "i2", name: "Google Calendar", provider: "google", kind: "scheduling", status: "chat_connected", mode: "external", last_sync_at: null, last_error: null, description: "ChatGPT connection is available; local CompanyOS OAuth is ready but not configured." },
  { id: "i3", name: "GitHub", provider: "github", kind: "engineering", status: "planned", mode: "local", last_sync_at: null, last_error: null, description: "Configure GITHUB_TOKEN to collect repositories and optional issue/PR data." },
  { id: "i4", name: "Proxmox", provider: "proxmox", kind: "infrastructure", status: "planned", mode: "local", last_sync_at: null, last_error: null, description: "Configure a Proxmox API token for server and node health checks." },
  { id: "i5", name: "Nextcloud", provider: "nextcloud", kind: "storage", status: "planned", mode: "local", last_sync_at: null, last_error: null, description: "Configure NEXTCLOUD_URL for Sky Mountain Cloud health checks." },
  { id: "i6", name: "Firebase / Analytics", provider: "firebase", kind: "analytics", status: "planned", mode: "webhook", last_sync_at: null, last_error: null, description: "Use the signed event-ingest endpoint or n8n to forward approved product analytics." },
  { id: "i7", name: "n8n", provider: "n8n", kind: "automation", status: "planned", mode: "webhook", last_sync_at: null, last_error: null, description: "Send signed operational events to CompanyOS from n8n workflows." },
];

export const demoBrandKits: BrandKit[] = [
  { project_id: "demo-1", project_name: "Sky Mountain Cloud", website_url: "https://skymountaincloud.com", logo_url: "", colors: ["#1e3a5f", "#38bdf8", "#f8fafc"], fonts: ["Inter"], phone: "", service_area: "", services: ["Nextcloud hosting", "Account provisioning", "Onboarding and support"], instagram_username: "skymountaincloud", tagline: "Sky Mountain Cloud", source: "demo" },
  { project_id: "demo-2", project_name: "Plenty of Plants", website_url: "", logo_url: "", colors: ["#166534", "#86efac", "#fefce8"], fonts: ["Inter"], phone: "", service_area: "", services: ["Plant care game", "Nursery partnerships"], instagram_username: "", tagline: "Plenty of Plants", source: "demo" },
  { project_id: "demo-3", project_name: "Sky Mountain Graphics", website_url: "", logo_url: "", colors: ["#7c2d12", "#f59e0b", "#fff7ed"], fonts: ["Montserrat"], phone: "", service_area: "", services: ["Graphic design", "Web design", "Branding"], instagram_username: "skymountaingraphics", tagline: "Sky Mountain Graphics", source: "demo" },
];

function demoWeekDate(offsetDays: number): string {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + offsetDays);
  return monday.toISOString().slice(0, 10);
}

export const demoContentItems: ContentItem[] = [
  { id: "ci-1", project_id: "demo-1", project_name: "Sky Mountain Cloud", type: "post", title: "Your files deserve a real cloud", caption: "Backups that just work — your photos, docs and projects, safe in your own cloud. ☁️", image_prompt: "Cozy home office, laptop with a cloud dashboard, warm light", image_url: "", image_options: [], status: "in_review", scheduled_for: demoWeekDate(0), published_url: "", created_by: "Marketing" },
  { id: "ci-2", project_id: "demo-1", project_name: "Sky Mountain Cloud", type: "story", title: "Behind the scenes: the home lab", caption: "Where your cloud actually lives.", image_prompt: "Server rack with soft blue lights, tidy cables", image_url: "", image_options: [], status: "draft", scheduled_for: demoWeekDate(3), published_url: "", created_by: "Marketing" },
  { id: "ci-3", project_id: "demo-2", project_name: "Plenty of Plants", type: "reel", title: "Watering day timelapse", caption: "Sixty plants, one watering day. 🌱", image_prompt: "Sunlit plant shelf, watering can mid-pour, green everywhere", image_url: "", image_options: [], status: "approved", scheduled_for: demoWeekDate(2), published_url: "", created_by: "Marketing" },
  { id: "ci-4", project_id: "demo-2", project_name: "Plenty of Plants", type: "post", title: "Meet the cast: the fern that survives everything", caption: "Some plants are just built different.", image_prompt: "Close-up of a lush fern in a terracotta pot by a window", image_url: "", image_options: [], status: "draft", scheduled_for: null, published_url: "", created_by: "owner" },
  { id: "ci-5", project_id: "demo-3", project_name: "Sky Mountain Graphics", type: "post", title: "Before / after: a logo refresh", caption: "Same business, sharper first impression.", image_prompt: "Split design desk scene: rough sketches on the left, polished logo on the right", image_url: "", image_options: [], status: "scheduled", scheduled_for: demoWeekDate(4), published_url: "", created_by: "Marketing" },
  { id: "ci-6", project_id: "demo-3", project_name: "Sky Mountain Graphics", type: "article", title: "What a small-business website must do in 2026", caption: "Draft for the WordPress blog.", image_prompt: "", image_url: "", image_options: [], status: "in_review", scheduled_for: demoWeekDate(5), published_url: "", created_by: "Marketing" },
];

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

export const demoSalesLeads: SalesLeadRow[] = [
  { id: "lead-1", project_id: "demo-3", project_name: "Sky Mountain Graphics", opportunity_title: "Logo and storefront sign refresh", stage: "proposal", estimated_value_cents: 180000, created_at: hoursAgo(50), first_contacted_at: hoursAgo(49.93) },
  { id: "lead-2", project_id: "demo-3", project_name: "Sky Mountain Graphics", opportunity_title: "Restaurant menu design package", stage: "won", estimated_value_cents: 95000, created_at: hoursAgo(160), first_contacted_at: hoursAgo(157) },
  { id: "lead-3", project_id: "demo-1", project_name: "Sky Mountain Cloud", opportunity_title: "Bakery team cloud setup (6 seats)", stage: "qualified", estimated_value_cents: 72000, created_at: hoursAgo(30), first_contacted_at: hoursAgo(28) },
  { id: "lead-4", project_id: "demo-1", project_name: "Sky Mountain Cloud", opportunity_title: "Photo studio backup migration", stage: "new", estimated_value_cents: 54000, created_at: hoursAgo(5), first_contacted_at: null },
  { id: "lead-5", project_id: "demo-2", project_name: "Plenty of Plants", opportunity_title: "Café plant-care partnership", stage: "proposal", estimated_value_cents: 40000, created_at: hoursAgo(96), first_contacted_at: hoursAgo(90) },
  { id: "lead-6", project_id: "demo-2", project_name: "Plenty of Plants", opportunity_title: "Office greenery subscription", stage: "lost", estimated_value_cents: 60000, created_at: hoursAgo(240), first_contacted_at: hoursAgo(214) },
];

export const demoLeadOutcomes: LeadOutcome[] = [
  { id: "oc-1", lead_id: "lead-1", project_name: "Sky Mountain Graphics", opportunity_title: "Logo and storefront sign refresh", outcome: "quote", created_at: hoursAgo(20) },
  { id: "oc-2", lead_id: "lead-2", project_name: "Sky Mountain Graphics", opportunity_title: "Restaurant menu design package", outcome: "won", created_at: hoursAgo(120) },
  { id: "oc-3", lead_id: "lead-3", project_name: "Sky Mountain Cloud", opportunity_title: "Bakery team cloud setup (6 seats)", outcome: "contacted", created_at: hoursAgo(28) },
  { id: "oc-4", lead_id: "lead-5", project_name: "Plenty of Plants", opportunity_title: "Café plant-care partnership", outcome: "visit", created_at: hoursAgo(80) },
];

const demoContacts: Contact[] = [
  { id: "contact-1", name: "Example Lead", email: "lead@example.com", organization: "Local Business", source: "demo", project_name: "Sky Mountain Graphics", status: "active", last_contact_at: new Date().toISOString() },
];

const demoMeetings: Meeting[] = [];
const demoAttention: AttentionItem[] = [
  { id: "attention-1", source: "demo", attention_type: "owner_review", priority: "high", title: "Review first business-growth workflow", description: "Starter attention item", status: "open", due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), project_name: "Sky Mountain Graphics", contact_name: null },
];

const emptyFinance: FinancialSnapshot = { revenue_cents: 0, expenses_cents: 0, ai_cost_cents: 0, profit_cents: 0 };
const emptyExternalSummary: ExternalSummary = { total: 0, by_provider: [], by_type: [] };

function sumFinance(rows: Array<{ revenue_cents: string | number; expenses_cents: string | number; ai_cost_cents: string | number }>): FinancialSnapshot {
  const revenue_cents = rows.reduce((sum, row) => sum + Number(row.revenue_cents), 0);
  const expenses_cents = rows.reduce((sum, row) => sum + Number(row.expenses_cents), 0);
  const ai_cost_cents = rows.reduce((sum, row) => sum + Number(row.ai_cost_cents), 0);
  return { revenue_cents, expenses_cents, ai_cost_cents, profit_cents: revenue_cents - expenses_cents };
}

type Source = "database" | "demo";

// Database availability is memoized briefly so one request's loaders share
// a single SELECT 1 probe instead of re-checking per slice.
let availabilityMemo: { at: number; value: boolean } | null = null;

async function dbSource(): Promise<Source> {
  const now = Date.now();
  if (!availabilityMemo || now - availabilityMemo.at > 2000) {
    availabilityMemo = { at: now, value: await databaseAvailable() };
  }
  return availabilityMemo.value ? "database" : "demo";
}

// Slice loaders: one query (or the demo constant) per dashboard slice.
// Pages and narrow API routes compose only the slices they render;
// getDashboardData composes all of them, exactly once each.

async function sliceProjects(): Promise<Project[]> {
  if ((await dbSource()) === "demo") return demoProjects;
  return (await query<Project>(`SELECT p.id, c.name AS company_name, p.name, p.slug, p.description, p.health, p.stage, p.progress,
      COUNT(DISTINCT t.id)::int AS task_count,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status NOT IN ('done', 'completed'))::int AS open_task_count
      FROM projects p JOIN companies c ON c.id=p.company_id LEFT JOIN tasks t ON t.project_id=p.id
      GROUP BY p.id,c.name ORDER BY p.name`)).rows;
}

async function sliceAgents(): Promise<Agent[]> {
  if ((await dbSource()) === "demo") return demoAgents;
  return (await query<Agent>(`SELECT a.id,a.name,a.role,a.department,a.reports_to,manager.name AS manager_name,a.provider,a.status,a.description,a.mission,
      a.allowed_actions,a.prohibited_actions,a.escalation_rules,a.success_metrics,a.memory_scope,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status NOT IN ('done', 'completed'))::int AS open_task_count,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status IN ('done', 'completed'))::int AS completed_task_count,
      COUNT(DISTINCT r.id) FILTER (WHERE r.status='completed' AND r.created_at >= NOW()-INTERVAL '30 days')::int AS completed_runs_30d,
      COUNT(DISTINCT r.id) FILTER (WHERE r.status='failed' AND r.created_at >= NOW()-INTERVAL '30 days')::int AS failed_runs_30d,
      CASE WHEN COUNT(DISTINCT r.id) FILTER (WHERE r.status IN ('completed','failed') AND r.created_at >= NOW()-INTERVAL '30 days') > 0
        THEN ROUND(100.0 * COUNT(DISTINCT r.id) FILTER (WHERE r.status='completed' AND r.created_at >= NOW()-INTERVAL '30 days')
          / NULLIF(COUNT(DISTINCT r.id) FILTER (WHERE r.status IN ('completed','failed') AND r.created_at >= NOW()-INTERVAL '30 days'),0))::int
        ELSE NULL END AS run_success_rate_30d,
      MAX(GREATEST(COALESCE(t.updated_at,t.created_at),COALESCE(r.completed_at,r.started_at,r.created_at)))::text AS last_activity_at
      FROM agents a LEFT JOIN agents manager ON manager.id=a.reports_to
      LEFT JOIN tasks t ON t.agent_id=a.id LEFT JOIN agent_runs r ON r.agent_id=a.id
      GROUP BY a.id,manager.name ORDER BY a.department,a.name`)).rows;
}

async function sliceTasks(): Promise<Task[]> {
  if ((await dbSource()) === "demo") return demoTasks;
  return (await query<Task>(`SELECT t.id,p.name AS project_name,p.slug AS project_slug,a.name AS agent_name,t.title,t.priority,t.status,t.due_at::text
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN agents a ON a.id=t.agent_id
      WHERE t.status NOT IN ('done', 'completed')
      ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
      COALESCE(t.due_at,'2999-12-31'::timestamptz),t.created_at DESC LIMIT 25`)).rows;
}

async function sliceEvents(): Promise<EventItem[]> {
  if ((await dbSource()) === "demo") return demoEvents;
  return (await query<EventItem>(`SELECT e.id,e.source,e.event_type,e.title,e.severity,e.created_at::text,p.name AS project_name
      FROM events e LEFT JOIN projects p ON p.id=e.project_id ORDER BY e.created_at DESC LIMIT 30`)).rows;
}

async function sliceApprovals(): Promise<Approval[]> {
  if ((await dbSource()) === "demo") return demoApprovals;
  return (await query<Approval>(`SELECT a.id,p.name AS project_name,a.requested_by,a.action,a.risk_level,a.reason,a.status,a.action_type,a.payload,a.created_at::text
      FROM approvals a LEFT JOIN projects p ON p.id=a.project_id WHERE a.status='pending' ORDER BY a.created_at DESC LIMIT 25`)).rows;
}

async function sliceIntegrations(): Promise<IntegrationConnection[]> {
  if ((await dbSource()) === "demo") return demoIntegrations;
  return (await query<IntegrationConnection>(`SELECT id,name,provider,kind,status,mode,last_sync_at::text,last_error,description
      FROM integration_connections ORDER BY name`)).rows;
}

async function sliceFinance(): Promise<FinancialSnapshot> {
  if ((await dbSource()) === "demo") return emptyFinance;
  const finance = await query<{ revenue_cents: string; expenses_cents: string; ai_cost_cents: string }>(`SELECT
      (COALESCE((SELECT SUM(revenue_cents) FROM financial_metrics WHERE metric_date >= date_trunc('month',CURRENT_DATE)::date),0)
       + COALESCE((SELECT SUM(amount_cents) FROM financial_transactions WHERE status='recorded' AND direction='income' AND transaction_date >= date_trunc('month',CURRENT_DATE)::date),0))::bigint AS revenue_cents,
      (COALESCE((SELECT SUM(expenses_cents) FROM financial_metrics WHERE metric_date >= date_trunc('month',CURRENT_DATE)::date),0)
       + COALESCE((SELECT SUM(amount_cents) FROM financial_transactions WHERE status='recorded' AND direction='expense' AND transaction_date >= date_trunc('month',CURRENT_DATE)::date),0))::bigint AS expenses_cents,
      COALESCE((SELECT SUM(ai_cost_cents) FROM financial_metrics WHERE metric_date >= date_trunc('month',CURRENT_DATE)::date),0)::bigint AS ai_cost_cents`);
  return sumFinance(finance.rows);
}

async function sliceExternal(): Promise<{ external_records: ExternalRecord[]; external_summary: ExternalSummary }> {
  if ((await dbSource()) === "demo") return { external_records: [], external_summary: emptyExternalSummary };
  const [externalRecords, byProvider, byType] = await Promise.all([
    query<ExternalRecord>(`SELECT id,provider,record_type,external_id,title,url,status,owner,occurred_at::text,last_seen_at::text
      FROM external_records ORDER BY COALESCE(occurred_at,last_seen_at) DESC LIMIT 40`),
    query<{ provider: string; count: string }>(`SELECT provider,COUNT(*)::text AS count FROM external_records GROUP BY provider ORDER BY COUNT(*) DESC`),
    query<{ record_type: string; count: string }>(`SELECT record_type,COUNT(*)::text AS count FROM external_records GROUP BY record_type ORDER BY COUNT(*) DESC`),
  ]);
  const total = externalRecords.rows.length > 0 ? Number((await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM external_records")).rows[0]?.count ?? 0) : 0;
  return {
    external_records: externalRecords.rows,
    external_summary: {
      total,
      by_provider: byProvider.rows.map((row) => ({ provider: row.provider, count: Number(row.count) })),
      by_type: byType.rows.map((row) => ({ record_type: row.record_type, count: Number(row.count) })),
    },
  };
}

async function sliceSystemChecks(): Promise<SystemCheck[]> {
  if ((await dbSource()) === "demo") return demoChecks;
  return (await query<SystemCheck>(`SELECT sc.id,p.name AS project_name,sc.system_name,sc.status,sc.latency_ms,sc.details,sc.checked_at::text
      FROM system_checks sc LEFT JOIN projects p ON p.id=sc.project_id ORDER BY sc.checked_at DESC LIMIT 50`)).rows;
}

async function sliceSyncRuns(): Promise<SyncRun[]> {
  if ((await dbSource()) === "demo") return [];
  return (await query<SyncRun>(`SELECT id,integration_name,status,records_seen,records_written,error,started_at::text,completed_at::text
      FROM sync_runs ORDER BY started_at DESC LIMIT 12`)).rows;
}

async function sliceContacts(): Promise<Contact[]> {
  if ((await dbSource()) === "demo") return demoContacts;
  return (await query<Contact>(`SELECT c.id,c.name,c.email,c.organization,c.source,c.status,c.last_contact_at::text,p.name AS project_name
      FROM contacts c LEFT JOIN projects p ON p.id=c.project_id ORDER BY COALESCE(c.last_contact_at,c.created_at) DESC LIMIT 30`)).rows;
}

async function sliceMeetings(): Promise<Meeting[]> {
  if ((await dbSource()) === "demo") return demoMeetings;
  return (await query<Meeting>(`SELECT m.id,m.provider,m.external_id,m.title,m.url,m.status,m.organizer,m.start_at::text,m.end_at::text,m.location,p.name AS project_name
      FROM meetings m LEFT JOIN projects p ON p.id=m.project_id WHERE m.start_at IS NOT NULL
      ORDER BY m.start_at ASC LIMIT 30`)).rows;
}

async function sliceAttention(): Promise<AttentionItem[]> {
  if ((await dbSource()) === "demo") return demoAttention;
  return (await query<AttentionItem>(`SELECT ai.id,ai.source,ai.attention_type,ai.priority,ai.title,ai.description,ai.status,ai.due_at::text,p.name AS project_name,c.name AS contact_name
      FROM attention_items ai LEFT JOIN projects p ON p.id=ai.project_id LEFT JOIN contacts c ON c.id=ai.contact_id
      WHERE ai.status='open' ORDER BY CASE ai.priority WHEN 'high' THEN 1 ELSE 2 END,COALESCE(ai.due_at,'2999-12-31'::timestamptz),ai.created_at DESC LIMIT 30`)).rows;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function sliceBrandKits(): Promise<BrandKit[]> {
  if ((await dbSource()) === "demo") return demoBrandKits;
  const rows = (await query<BrandKit & { colors: unknown; fonts: unknown; services: unknown }>(`SELECT p.id AS project_id,p.name AS project_name,bk.website_url,bk.logo_url,bk.colors,bk.fonts,bk.phone,
      bk.service_area,bk.services,bk.instagram_username,bk.tagline,bk.source,bk.updated_at::text
      FROM projects p LEFT JOIN brand_kits bk ON bk.project_id=p.id ORDER BY p.name`)).rows;
  // One row per project: a project without a saved kit gets an empty kit the
  // owner can fill in, so the Agency desk always shows all three businesses.
  return rows.map((row) => ({
    project_id: row.project_id,
    project_name: row.project_name,
    website_url: row.website_url ?? "",
    logo_url: row.logo_url ?? "",
    colors: asStringArray(row.colors),
    fonts: asStringArray(row.fonts),
    phone: row.phone ?? "",
    service_area: row.service_area ?? "",
    services: asStringArray(row.services),
    instagram_username: row.instagram_username ?? "",
    tagline: row.tagline ?? "",
    source: row.source ?? "manual",
    updated_at: row.updated_at ?? null,
  }));
}

async function sliceContentItems(): Promise<ContentItem[]> {
  if ((await dbSource()) === "demo") return demoContentItems;
  const rows = (await query<ContentItem & { image_options: unknown }>(`SELECT ci.id,ci.project_id,p.name AS project_name,ci.type,ci.title,ci.caption,ci.image_prompt,ci.image_url,
      ci.image_options,ci.status,ci.scheduled_for::text,ci.published_url,ci.created_by,ci.created_at::text,ci.updated_at::text
      FROM content_items ci JOIN projects p ON p.id=ci.project_id
      ORDER BY ci.scheduled_for NULLS LAST, ci.created_at DESC LIMIT 160`)).rows;
  return rows.map((row) => ({ ...row, image_options: asStringArray(row.image_options) }));
}

async function sliceSalesLeads(): Promise<SalesLeadRow[]> {
  if ((await dbSource()) === "demo") return demoSalesLeads;
  return (await query<SalesLeadRow>(`SELECT l.id,l.project_id,p.name AS project_name,l.opportunity_title,l.stage,
      l.estimated_value_cents::text,l.created_at::text,l.first_contacted_at::text
      FROM sales_leads l JOIN projects p ON p.id=l.project_id
      ORDER BY l.created_at DESC LIMIT 200`)).rows;
}

async function sliceLeadOutcomes(): Promise<LeadOutcome[]> {
  if ((await dbSource()) === "demo") return demoLeadOutcomes;
  return (await query<LeadOutcome>(`SELECT o.id,o.lead_id,p.name AS project_name,l.opportunity_title,o.outcome,o.note,o.created_at::text
      FROM lead_outcomes o JOIN sales_leads l ON l.id=o.lead_id JOIN projects p ON p.id=l.project_id
      ORDER BY o.created_at DESC LIMIT 60`)).rows;
}

async function sourceOf<T extends object>(slices: T): Promise<T & { source: Source }> {
  return { source: await dbSource(), ...slices };
}

// Per-domain loaders for pages and narrow routes.

export async function getProjectsData() {
  return sourceOf({ projects: await sliceProjects() });
}

export async function getAgentsData() {
  const [agents, tasks] = await Promise.all([sliceAgents(), sliceTasks()]);
  return sourceOf({ agents, tasks });
}

export async function getTasksData() {
  return sourceOf({ tasks: await sliceTasks() });
}

export async function getEventsData() {
  return sourceOf({ events: await sliceEvents() });
}

export async function getApprovalsData() {
  return sourceOf({ approvals: await sliceApprovals() });
}

export async function getIntegrationsData() {
  return sourceOf({ integrations: await sliceIntegrations() });
}

export async function getFinanceData() {
  return sourceOf({ finance: await sliceFinance() });
}

export async function getCommunicationsData() {
  const [events, integrations, external] = await Promise.all([sliceEvents(), sliceIntegrations(), sliceExternal()]);
  return sourceOf({ events, integrations, external_records: external.external_records });
}

export async function getOperationsData() {
  const [system_checks, integrations, sync_runs, external] = await Promise.all([sliceSystemChecks(), sliceIntegrations(), sliceSyncRuns(), sliceExternal()]);
  return sourceOf({ system_checks, integrations, sync_runs, external_summary: external.external_summary });
}

export async function getIntelligenceData() {
  const [contacts, meetings, attention_items] = await Promise.all([sliceContacts(), sliceMeetings(), sliceAttention()]);
  return sourceOf({ contacts, meetings, attention_items });
}

export async function getBrandKitsData() {
  return sourceOf({ brand_kits: await sliceBrandKits() });
}

/** The Agency desk (Lead Desk model): departments with live work, the
 *  pending-approval queue, and one brand kit per business. */
export async function getAgencyData() {
  const [projects, agents, tasks, approvals, brand_kits] = await Promise.all([sliceProjects(), sliceAgents(), sliceTasks(), sliceApprovals(), sliceBrandKits()]);
  return sourceOf({ projects, agents, tasks, approvals, brand_kits });
}

/** The content planner + design studio (Lead Desk Phase 2): content items
 *  for the week grid, with each business's brand kit for publishing context. */
export async function getContentData() {
  const [projects, brand_kits, content_items] = await Promise.all([sliceProjects(), sliceBrandKits(), sliceContentItems()]);
  return sourceOf({ projects, brand_kits, content_items });
}

/** The Results roll-up (Lead Desk Phase 3): leads with first-response
 *  timing, the outcome log, and content output, per business. */
export async function getResultsData() {
  const [projects, sales_leads, lead_outcomes, content_items] = await Promise.all([sliceProjects(), sliceSalesLeads(), sliceLeadOutcomes(), sliceContentItems()]);
  return sourceOf({ projects, sales_leads, lead_outcomes, content_items });
}

/** The full dashboard. Only the Overview, /api/overview and the command
 *  router need every slice; everything else uses a per-domain loader. */
export async function getDashboardData(): Promise<DashboardData> {
  const [projects, agents, tasks, events, approvals, system_checks, integrations, finance, external, sync_runs, contacts, meetings, attention_items] = await Promise.all([
    sliceProjects(),
    sliceAgents(),
    sliceTasks(),
    sliceEvents(),
    sliceApprovals(),
    sliceSystemChecks(),
    sliceIntegrations(),
    sliceFinance(),
    sliceExternal(),
    sliceSyncRuns(),
    sliceContacts(),
    sliceMeetings(),
    sliceAttention(),
  ]);
  return {
    source: await dbSource(),
    generated_at: new Date().toISOString(),
    projects,
    agents,
    tasks,
    events,
    approvals,
    system_checks,
    integrations,
    finance,
    external_records: external.external_records,
    external_summary: external.external_summary,
    sync_runs,
    contacts,
    meetings,
    attention_items,
  };
}
