export type Project = {
  id: string;
  company_name: string;
  name: string;
  slug: string;
  description: string | null;
  health: string;
  stage: string;
  progress: number;
  task_count?: number;
  open_task_count?: number;
};

export type Agent = {
  id: string;
  name: string;
  role: string;
  department: string;
  reports_to?: string | null;
  manager_name?: string | null;
  provider: string;
  status: string;
  description: string | null;
  mission?: string | null;
  allowed_actions?: string[];
  prohibited_actions?: string[];
  escalation_rules?: string[];
  success_metrics?: string[];
  memory_scope?: string[];
  open_task_count?: number;
  completed_task_count?: number;
  completed_runs_30d?: number;
  failed_runs_30d?: number;
  run_success_rate_30d?: number | null;
  last_activity_at?: string | null;
};

export type Task = {
  id: string;
  project_name: string | null;
  project_slug?: string | null;
  agent_name: string | null;
  title: string;
  priority: string;
  status: string;
  due_at?: string | null;
};

export type EventItem = {
  id: string;
  source: string;
  event_type?: string;
  title: string;
  severity: string;
  created_at: string;
  project_name?: string | null;
};

export type Approval = {
  id: string;
  project_name: string | null;
  requested_by: string;
  action: string;
  risk_level: string;
  reason: string | null;
  status: string;
  action_type?: string | null;
  payload?: Record<string, unknown> | null;
  created_at?: string;
};

export type FinancialSnapshot = {
  revenue_cents: number;
  expenses_cents: number;
  ai_cost_cents: number;
  profit_cents: number;
};

export type SystemCheck = {
  id: string;
  project_name?: string | null;
  system_name: string;
  status: string;
  latency_ms: number | null;
  details: string | null;
  checked_at: string;
};

export type IntegrationConnection = {
  id: string;
  name: string;
  provider: string;
  kind: string;
  status: string;
  mode: string;
  last_sync_at: string | null;
  last_error: string | null;
  description: string | null;
};

export type ExternalRecord = {
  id: string;
  provider: string;
  record_type: string;
  external_id: string;
  title: string;
  url: string | null;
  status: string | null;
  owner: string | null;
  occurred_at: string | null;
  last_seen_at: string;
};

export type SyncRun = {
  id: string;
  integration_name: string;
  status: string;
  records_seen: number;
  records_written: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};

export type ExternalSummary = {
  total: number;
  by_provider: Array<{ provider: string; count: number }>;
  by_type: Array<{ record_type: string; count: number }>;
};


export type Contact = {
  id: string;
  name: string | null;
  email: string | null;
  organization: string | null;
  source: string;
  project_name?: string | null;
  status: string;
  last_contact_at: string | null;
};

export type Meeting = {
  id: string;
  provider: string;
  external_id: string;
  title: string;
  url: string | null;
  status: string;
  organizer: string | null;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  project_name?: string | null;
};

export type AttentionItem = {
  id: string;
  source: string;
  attention_type: string;
  priority: string;
  title: string;
  description: string | null;
  status: string;
  due_at: string | null;
  project_name?: string | null;
  contact_name?: string | null;
};

export type DashboardData = {
  source: "database" | "demo";
  generated_at: string;
  projects: Project[];
  agents: Agent[];
  tasks: Task[];
  events: EventItem[];
  approvals: Approval[];
  system_checks: SystemCheck[];
  integrations: IntegrationConnection[];
  finance: FinancialSnapshot;
  external_records: ExternalRecord[];
  external_summary: ExternalSummary;
  sync_runs: SyncRun[];
  contacts: Contact[];
  meetings: Meeting[];
  attention_items: AttentionItem[];
};
