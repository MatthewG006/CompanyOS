import { databaseAvailable, query } from "./db";
import type {
  Agent,
  Approval,
  AttentionItem,
  Contact,
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
  { id: "a8", name: "Marketing", role: "Marketing Manager", department: "Marketing", manager_name: "COO", reports_to: "a2", provider: "agnostic", status: "idle", description: "Campaigns, content, partnerships and analytics.", open_task_count: 0 },
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

export async function getDashboardData(): Promise<DashboardData> {
  if (!(await databaseAvailable())) {
    return {
      source: "demo",
      generated_at: new Date().toISOString(),
      projects: demoProjects,
      agents: demoAgents,
      tasks: demoTasks,
      events: demoEvents,
      approvals: demoApprovals,
      system_checks: demoChecks,
      integrations: demoIntegrations,
      finance: emptyFinance,
      external_records: [],
      external_summary: emptyExternalSummary,
      sync_runs: [],
      contacts: demoContacts,
      meetings: demoMeetings,
      attention_items: demoAttention,
    };
  }

  const [projects, agents, tasks, events, approvals, systemChecks, integrations, finance, externalRecords, byProvider, byType, syncRuns, contacts, meetings, attentionItems] = await Promise.all([
    query<Project>(`SELECT p.id, c.name AS company_name, p.name, p.slug, p.description, p.health, p.stage, p.progress,
      COUNT(DISTINCT t.id)::int AS task_count,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status <> 'done')::int AS open_task_count
      FROM projects p JOIN companies c ON c.id=p.company_id LEFT JOIN tasks t ON t.project_id=p.id
      GROUP BY p.id,c.name ORDER BY p.name`),
    query<Agent>(`SELECT a.id,a.name,a.role,a.department,a.reports_to,manager.name AS manager_name,a.provider,a.status,a.description,a.mission,
      a.allowed_actions,a.prohibited_actions,a.escalation_rules,a.success_metrics,a.memory_scope,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status <> 'done')::int AS open_task_count,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status='done')::int AS completed_task_count,
      COUNT(DISTINCT r.id) FILTER (WHERE r.status='completed' AND r.created_at >= NOW()-INTERVAL '30 days')::int AS completed_runs_30d,
      COUNT(DISTINCT r.id) FILTER (WHERE r.status='failed' AND r.created_at >= NOW()-INTERVAL '30 days')::int AS failed_runs_30d,
      CASE WHEN COUNT(DISTINCT r.id) FILTER (WHERE r.status IN ('completed','failed') AND r.created_at >= NOW()-INTERVAL '30 days') > 0
        THEN ROUND(100.0 * COUNT(DISTINCT r.id) FILTER (WHERE r.status='completed' AND r.created_at >= NOW()-INTERVAL '30 days')
          / NULLIF(COUNT(DISTINCT r.id) FILTER (WHERE r.status IN ('completed','failed') AND r.created_at >= NOW()-INTERVAL '30 days'),0))::int
        ELSE NULL END AS run_success_rate_30d,
      MAX(GREATEST(COALESCE(t.updated_at,t.created_at),COALESCE(r.completed_at,r.started_at,r.created_at)))::text AS last_activity_at
      FROM agents a LEFT JOIN agents manager ON manager.id=a.reports_to
      LEFT JOIN tasks t ON t.agent_id=a.id LEFT JOIN agent_runs r ON r.agent_id=a.id
      GROUP BY a.id,manager.name ORDER BY a.department,a.name`),
    query<Task>(`SELECT t.id,p.name AS project_name,p.slug AS project_slug,a.name AS agent_name,t.title,t.priority,t.status,t.due_at::text
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN agents a ON a.id=t.agent_id
      WHERE t.status <> 'done'
      ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
      COALESCE(t.due_at,'2999-12-31'::timestamptz),t.created_at DESC LIMIT 25`),
    query<EventItem>(`SELECT e.id,e.source,e.event_type,e.title,e.severity,e.created_at::text,p.name AS project_name
      FROM events e LEFT JOIN projects p ON p.id=e.project_id ORDER BY e.created_at DESC LIMIT 30`),
    query<Approval>(`SELECT a.id,p.name AS project_name,a.requested_by,a.action,a.risk_level,a.reason,a.status,a.action_type,a.payload,a.created_at::text
      FROM approvals a LEFT JOIN projects p ON p.id=a.project_id WHERE a.status='pending' ORDER BY a.created_at DESC LIMIT 25`),
    query<SystemCheck>(`SELECT sc.id,p.name AS project_name,sc.system_name,sc.status,sc.latency_ms,sc.details,sc.checked_at::text
      FROM system_checks sc LEFT JOIN projects p ON p.id=sc.project_id ORDER BY sc.checked_at DESC LIMIT 50`),
    query<IntegrationConnection>(`SELECT id,name,provider,kind,status,mode,last_sync_at::text,last_error,description
      FROM integration_connections ORDER BY name`),
    query<{ revenue_cents: string; expenses_cents: string; ai_cost_cents: string }>(`SELECT
      (COALESCE((SELECT SUM(revenue_cents) FROM financial_metrics WHERE metric_date >= date_trunc('month',CURRENT_DATE)::date),0)
       + COALESCE((SELECT SUM(amount_cents) FROM financial_transactions WHERE status='recorded' AND direction='income' AND transaction_date >= date_trunc('month',CURRENT_DATE)::date),0))::bigint AS revenue_cents,
      (COALESCE((SELECT SUM(expenses_cents) FROM financial_metrics WHERE metric_date >= date_trunc('month',CURRENT_DATE)::date),0)
       + COALESCE((SELECT SUM(amount_cents) FROM financial_transactions WHERE status='recorded' AND direction='expense' AND transaction_date >= date_trunc('month',CURRENT_DATE)::date),0))::bigint AS expenses_cents,
      COALESCE((SELECT SUM(ai_cost_cents) FROM financial_metrics WHERE metric_date >= date_trunc('month',CURRENT_DATE)::date),0)::bigint AS ai_cost_cents`),
    query<ExternalRecord>(`SELECT id,provider,record_type,external_id,title,url,status,owner,occurred_at::text,last_seen_at::text
      FROM external_records ORDER BY COALESCE(occurred_at,last_seen_at) DESC LIMIT 40`),
    query<{ provider: string; count: string }>(`SELECT provider,COUNT(*)::text AS count FROM external_records GROUP BY provider ORDER BY COUNT(*) DESC`),
    query<{ record_type: string; count: string }>(`SELECT record_type,COUNT(*)::text AS count FROM external_records GROUP BY record_type ORDER BY COUNT(*) DESC`),
    query<SyncRun>(`SELECT id,integration_name,status,records_seen,records_written,error,started_at::text,completed_at::text
      FROM sync_runs ORDER BY started_at DESC LIMIT 12`),
    query<Contact>(`SELECT c.id,c.name,c.email,c.organization,c.source,c.status,c.last_contact_at::text,p.name AS project_name
      FROM contacts c LEFT JOIN projects p ON p.id=c.project_id ORDER BY COALESCE(c.last_contact_at,c.created_at) DESC LIMIT 30`),
    query<Meeting>(`SELECT m.id,m.provider,m.external_id,m.title,m.url,m.status,m.organizer,m.start_at::text,m.end_at::text,m.location,p.name AS project_name
      FROM meetings m LEFT JOIN projects p ON p.id=m.project_id WHERE m.start_at IS NOT NULL
      ORDER BY m.start_at ASC LIMIT 30`),
    query<AttentionItem>(`SELECT ai.id,ai.source,ai.attention_type,ai.priority,ai.title,ai.description,ai.status,ai.due_at::text,p.name AS project_name,c.name AS contact_name
      FROM attention_items ai LEFT JOIN projects p ON p.id=ai.project_id LEFT JOIN contacts c ON c.id=ai.contact_id
      WHERE ai.status='open' ORDER BY CASE ai.priority WHEN 'high' THEN 1 ELSE 2 END,COALESCE(ai.due_at,'2999-12-31'::timestamptz),ai.created_at DESC LIMIT 30`),
  ]);

  return {
    source: "database",
    generated_at: new Date().toISOString(),
    projects: projects.rows,
    agents: agents.rows,
    tasks: tasks.rows,
    events: events.rows,
    approvals: approvals.rows,
    system_checks: systemChecks.rows,
    integrations: integrations.rows,
    finance: sumFinance(finance.rows),
    external_records: externalRecords.rows,
    external_summary: {
      total: externalRecords.rows.length > 0 ? Number((await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM external_records")).rows[0]?.count ?? 0) : 0,
      by_provider: byProvider.rows.map((row) => ({ provider: row.provider, count: Number(row.count) })),
      by_type: byType.rows.map((row) => ({ record_type: row.record_type, count: Number(row.count) })),
    },
    sync_runs: syncRuns.rows,
    contacts: contacts.rows,
    meetings: meetings.rows,
    attention_items: attentionItems.rows,
  };
}
