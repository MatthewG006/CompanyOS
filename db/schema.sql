CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  health TEXT NOT NULL DEFAULT 'healthy',
  stage TEXT NOT NULL DEFAULT 'active',
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_memories (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Shared project memory',
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  department TEXT NOT NULL,
  reports_to UUID REFERENCES agents(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'agnostic',
  status TEXT NOT NULL DEFAULT 'idle',
  description TEXT,
  mission TEXT,
  allowed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  prohibited_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  escalation_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
  memory_scope JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS reports_to UUID REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS mission TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_actions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS prohibited_actions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS escalation_rules JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS success_metrics JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS memory_scope JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE agents SET mission=description WHERE mission IS NULL;
UPDATE agents SET memory_scope='["project","tasks","systems"]'::jsonb WHERE memory_scope='[]'::jsonb;
UPDATE agents SET allowed_actions='["request_task_creation"]'::jsonb WHERE allowed_actions='[]'::jsonb;
UPDATE agents SET allowed_actions=allowed_actions || '["request_task_status_change"]'::jsonb
  WHERE allowed_actions ? 'request_task_creation' AND NOT (allowed_actions ? 'request_task_status_change');

WITH reporting(child_name,parent_name) AS (VALUES
  ('COO','CEO'),('CTO','CEO'),('Engineer','CTO'),('QA','CTO'),('DevOps','CTO'),
  ('Sales','COO'),('Marketing','COO'),('Support','COO'),('Finance','CEO'),('Research','CEO')
), matched AS (
  SELECT child.id AS child_id,parent.id AS parent_id
  FROM reporting r JOIN agents child ON LOWER(child.name)=LOWER(r.child_name)
  JOIN agents parent ON LOWER(parent.name)=LOWER(r.parent_name)
)
UPDATE agents child SET reports_to=matched.parent_id
FROM matched WHERE child.id=matched.child_id AND child.reports_to IS NULL;

UPDATE agents manager SET allowed_actions=manager.allowed_actions || '["request_task_delegation"]'::jsonb
WHERE manager.allowed_actions ? 'request_task_creation'
  AND NOT (manager.allowed_actions ? 'request_task_delegation')
  AND EXISTS (SELECT 1 FROM agents child WHERE child.reports_to=manager.id);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'todo',
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{"reasoning":true}'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS constraints JSONB NOT NULL DEFAULT '{"dataSensitivity":"internal"}'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS preferred_providers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS fallback_providers JSONB NOT NULL DEFAULT '[]'::jsonb;


CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  requested_by TEXT NOT NULL,
  action TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'high',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  action_type TEXT,
  proposal_index INTEGER,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS action_type TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS proposal_index INTEGER;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS payload JSONB;

CREATE TABLE IF NOT EXISTS financial_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  metric_date DATE NOT NULL,
  revenue_cents BIGINT NOT NULL DEFAULT 0,
  expenses_cents BIGINT NOT NULL DEFAULT 0,
  ai_cost_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, metric_date)
);

CREATE TABLE IF NOT EXISTS financial_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
  direction TEXT NOT NULL CHECK (direction IN ('income','expense')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_date_status ON financial_transactions(transaction_date DESC,status);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_project ON financial_transactions(project_id,transaction_date DESC);

CREATE TABLE IF NOT EXISTS financial_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS financial_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES financial_import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  transaction_date DATE NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('income','expense')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  category TEXT NOT NULL DEFAULT 'other',
  description TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','duplicate','recorded','rejected')),
  duplicate_note TEXT,
  transaction_id UUID REFERENCES financial_transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(batch_id,row_number)
);
CREATE INDEX IF NOT EXISTS idx_financial_import_batches_created ON financial_import_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financial_import_rows_batch_status ON financial_import_rows(batch_id,status,row_number);
CREATE INDEX IF NOT EXISTS idx_financial_import_rows_fingerprint ON financial_import_rows(fingerprint,status);
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS source_import_row_id UUID REFERENCES financial_import_rows(id) ON DELETE SET NULL;
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS source_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_transactions_import_row ON financial_transactions(source_import_row_id) WHERE source_import_row_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financial_transactions_fingerprint ON financial_transactions(source_fingerprint) WHERE source_fingerprint IS NOT NULL;
UPDATE agents SET allowed_actions=COALESCE(allowed_actions,'[]'::jsonb) || '["request_financial_entry"]'::jsonb
WHERE LOWER(name)='finance' AND NOT (COALESCE(allowed_actions,'[]'::jsonb) ? 'request_financial_entry');

CREATE TABLE IF NOT EXISTS system_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  latency_ms INTEGER,
  details TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  mode TEXT NOT NULL DEFAULT 'local',
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS command_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command TEXT NOT NULL,
  route TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  response TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'agnostic',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  summary TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS input JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS retry_of_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_retry_once ON agent_runs(retry_of_run_id) WHERE retry_of_run_id IS NOT NULL;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_approval_proposal ON approvals(agent_run_id,proposal_index)
  WHERE agent_run_id IS NOT NULL AND proposal_index IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  records_seen INTEGER NOT NULL DEFAULT 0,
  records_written INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS external_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  record_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  status TEXT,
  owner TEXT,
  occurred_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, record_type, external_id)
);

UPDATE integration_connections SET name='Firebase / Analytics' WHERE name='Firebase';

INSERT INTO integration_connections (name,provider,kind,status,mode,description) VALUES
  ('Gmail','google','communications','chat_connected','external','ChatGPT Gmail access is separate; local CompanyOS OAuth is ready when Google credentials are configured.'),
  ('Google Calendar','google','scheduling','chat_connected','external','ChatGPT Calendar access is separate; local CompanyOS OAuth is ready when Google credentials are configured.'),
  ('GitHub','github','engineering','planned','local','Configure GITHUB_TOKEN for repository and optional issue/PR collection.'),
  ('Proxmox','proxmox','infrastructure','planned','local','Configure a Proxmox API token for node health collection.'),
  ('Nextcloud','nextcloud','storage','planned','local','Configure NEXTCLOUD_URL for Sky Mountain Cloud health checks.'),
  ('Firebase / Analytics','firebase','analytics','planned','webhook','Forward approved Firebase analytics through n8n or the signed CompanyOS event endpoint.'),
  ('n8n','n8n','automation','planned','webhook','Send signed events into CompanyOS from n8n workflows.')
ON CONFLICT (name) DO UPDATE SET provider=EXCLUDED.provider,kind=EXCLUDED.kind,description=EXCLUDED.description,updated_at=NOW();

CREATE INDEX IF NOT EXISTS idx_projects_company_id ON projects(company_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at);
ALTER TABLE events ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency_unique ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_idempotency ON events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_system_checks_checked_at ON system_checks(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_command_runs_created_at ON command_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_records_occurred_at ON external_records(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_records_provider_type ON external_records(provider, record_type);
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key TEXT UNIQUE NOT NULL,
  name TEXT,
  email TEXT,
  organization TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_contact_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone TEXT;

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  organizer TEXT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  location TEXT,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS attention_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_record_id UUID REFERENCES external_records(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  attention_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  due_at TIMESTAMPTZ,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(external_record_id, attention_type)
);

CREATE INDEX IF NOT EXISTS idx_contacts_project ON contacts(project_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_last_contact ON contacts(last_contact_at DESC);
CREATE TABLE IF NOT EXISTS sales_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  opportunity_title TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','qualified','proposal','won','lost')),
  estimated_value_cents BIGINT NOT NULL DEFAULT 0 CHECK (estimated_value_cents >= 0),
  follow_up_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_leads_project_stage ON sales_leads(project_id,stage,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_leads_follow_up ON sales_leads(follow_up_at) WHERE follow_up_at IS NOT NULL;
ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS source_attention_item_id UUID REFERENCES attention_items(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_leads_source_attention ON sales_leads(source_attention_item_id) WHERE source_attention_item_id IS NOT NULL;
UPDATE agents SET allowed_actions=COALESCE(allowed_actions,'[]'::jsonb) || '["request_sales_lead"]'::jsonb
WHERE LOWER(name)='sales' AND NOT (COALESCE(allowed_actions,'[]'::jsonb) ? 'request_sales_lead');

CREATE TABLE IF NOT EXISTS contact_channel_preferences (
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
  status TEXT NOT NULL CHECK (status IN ('opted_in','opted_out')),
  evidence TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(contact_id,channel)
);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','whatsapp')),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_approval',
  provider_message_id TEXT,
  provider_thread_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sending_started_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT
);
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS sending_started_at TIMESTAMPTZ;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_status_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_status_check CHECK (status IN ('awaiting_approval','queued','sending','sent','rejected','failed'));
CREATE INDEX IF NOT EXISTS idx_outbound_messages_contact ON outbound_messages(contact_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_thread ON outbound_messages(provider_thread_id) WHERE provider_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_messages_queue ON outbound_messages(status,next_attempt_at,created_at) WHERE status IN ('queued','sending');

CREATE TABLE IF NOT EXISTS sales_followup_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_lead_id UUID NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','superseded','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(sales_lead_id,scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_sales_followup_open ON sales_followup_reminders(status,scheduled_for) WHERE status='open';

CREATE TABLE IF NOT EXISTS customer_onboardings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_lead_id UUID NOT NULL UNIQUE REFERENCES sales_leads(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS onboarding_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES customer_onboardings(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(onboarding_id,position)
);

CREATE TABLE IF NOT EXISTS support_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','resolved','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_support_cases_project_status ON support_cases(project_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_cases_contact ON support_cases(contact_id);
CREATE INDEX IF NOT EXISTS idx_customer_onboardings_status ON customer_onboardings(status,updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_at);
CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings(project_id);
CREATE INDEX IF NOT EXISTS idx_attention_status_due ON attention_items(status, due_at);
CREATE INDEX IF NOT EXISTS idx_attention_project ON attention_items(project_id);
CREATE INDEX IF NOT EXISTS idx_attention_priority ON attention_items(priority, created_at DESC);

ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS source_attention_item_id UUID REFERENCES attention_items(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_transactions_source_attention ON financial_transactions(source_attention_item_id) WHERE source_attention_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_key TEXT NOT NULL,
  attention_item_id UUID NOT NULL REFERENCES attention_items(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(attention_item_id, workflow_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_dispatches_created ON workflow_dispatches(created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_heartbeats (
  service_name TEXT PRIMARY KEY,
  instance_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing synced attention is baseline data. Do not create a backlog of agent work on upgrade.
INSERT INTO workflow_dispatches (workflow_key, attention_item_id, project_id, status)
SELECT 'gmail_attention_to_agent_task_v1', ai.id, ai.project_id, 'existing_at_enablement'
FROM attention_items ai
WHERE ai.source='google-gmail' AND ai.attention_type='email_follow_up'
ON CONFLICT (attention_item_id, workflow_key) DO NOTHING;
