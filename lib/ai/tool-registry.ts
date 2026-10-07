import type { PoolClient } from "pg";
import { sendGoogleEmail } from "@/lib/integrations/google";

type AgentActionRequest = {
  reason: string;
  title?: string;
  priority?: "low" | "normal" | "high" | "critical";
  status?: "in_progress" | "done" | "waiting" | "resolved";
  assigneeAgentId?: string;
  amountCents?: number;
  transactionDate?: string;
  description?: string;
  opportunityTitle?: string;
  recipient?: string;
  subject?: string;
  body?: string;
};

type AgentTool = {
  actionType: string;
  permission: string;
  parseProposal(value: Record<string, unknown>): AgentActionRequest | null;
  approvalPayload(value: AgentActionRequest): Record<string, unknown>;
  approvalLabel(value: AgentActionRequest): string;
  execute(client: PoolClient, projectId: string | null, agentId: string | null, payload: unknown, runId: string): Promise<string>;
};

function boundedText(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").trim().slice(0, limit);
}

const createTaskTool: AgentTool = {
  actionType: "create_task",
  permission: "request_task_creation",
  parseProposal(value) {
    const title = boundedText(value.title, 200);
    const reason = boundedText(value.reason, 500);
    const priority = ["low", "normal", "high", "critical"].includes(String(value.priority)) ? value.priority as AgentActionRequest["priority"] : "normal";
    return value.type === "create_task" && title && reason ? { title, reason, priority } : null;
  },
  approvalPayload(value) {
    return { title: value.title, priority: value.priority };
  },
  approvalLabel(value) {
    return `Create follow-up task: ${value.title}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const title = boundedText(payload.title, 200);
    const priority = ["low", "normal", "high", "critical"].includes(String(payload.priority)) ? String(payload.priority) : "";
    if (!title || !priority || !projectId || !agentId) throw new Error("The approved task payload is invalid.");
    const assignment = await client.query(
      `SELECT 1 FROM agent_runs r JOIN tasks t ON t.id=r.task_id
       WHERE r.id=$1 AND r.agent_id=$2 AND t.project_id=$3 AND t.agent_id=$2`,
      [runId, agentId, projectId],
    );
    if (!assignment.rowCount) throw new Error("The original task is no longer assigned to this agent in the same project.");
    const result = await client.query<{ id: string }>(
      `INSERT INTO tasks (project_id,agent_id,title,priority,status) VALUES ($1,$2,$3,$4,'todo') RETURNING id`,
      [projectId, agentId, title, priority],
    );
    return result.rows[0].id;
  },
};

const updateTaskStatusTool: AgentTool = {
  actionType: "set_task_status",
  permission: "request_task_status_change",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const status = value.status === "done" || value.status === "in_progress" ? value.status : undefined;
    return value.type === "set_task_status" && status && reason ? { status, reason } : null;
  },
  approvalPayload(value) {
    return { status: value.status };
  },
  approvalLabel(value) {
    return `Set assigned task status to ${value.status === "done" ? "done" : "in progress"}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const status = payload.status === "done" || payload.status === "in_progress" ? payload.status : null;
    if (!status || !projectId || !agentId) throw new Error("The approved task status payload is invalid.");
    const result = await client.query<{ id: string }>(
      `UPDATE tasks SET status=$4,updated_at=NOW()
       WHERE id=(SELECT task_id FROM agent_runs WHERE id=$1 AND agent_id=$2)
         AND project_id=$3 AND agent_id=$2 AND status<>'done' RETURNING id`,
      [runId, agentId, projectId, status],
    );
    if (!result.rowCount) throw new Error("The assigned task has changed or is already complete; approval was not applied.");
    const onboardingSteps = await client.query<{ onboarding_id: string }>(
      `UPDATE onboarding_steps SET status=$2,updated_at=NOW(),completed_at=CASE WHEN $2='done' THEN NOW() ELSE NULL END
       WHERE task_id=$1 RETURNING onboarding_id`,
      [result.rows[0].id, status === "done" ? "done" : "in_progress"],
    );
    for (const step of onboardingSteps.rows) {
      const remaining = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM onboarding_steps WHERE onboarding_id=$1 AND status<>'done'",
        [step.onboarding_id],
      );
      const completed = Number(remaining.rows[0]?.count ?? 0) === 0;
      await client.query("UPDATE customer_onboardings SET status=$2,updated_at=NOW(),completed_at=CASE WHEN $2='completed' THEN NOW() ELSE NULL END WHERE id=$1", [step.onboarding_id, completed ? "completed" : "in_progress"]);
    }
    return result.rows[0].id;
  },
};

const updateSupportCaseTool: AgentTool = {
  actionType: "update_support_case",
  permission: "request_support_case_update",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const status = ["in_progress", "waiting", "resolved"].includes(String(value.status)) ? value.status as AgentActionRequest["status"] : undefined;
    return value.type === "update_support_case" && status && reason.length >= 8 ? { status, reason } : null;
  },
  approvalPayload(value) { return { status: value.status }; },
  approvalLabel(value) { return `Set assigned support case to ${value.status}`; },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const status = ["in_progress", "waiting", "resolved"].includes(String(payload.status)) ? String(payload.status) : "";
    if (!status || !projectId || !agentId) throw new Error("The approved support case status is invalid.");
    const result = await client.query<{ id: string; task_id: string }>(
      `SELECT sc.id,sc.task_id FROM support_cases sc JOIN tasks t ON t.id=sc.task_id
       JOIN agent_runs r ON r.task_id=t.id JOIN agents a ON a.id=r.agent_id
       WHERE r.id=$1 AND r.agent_id=$2 AND LOWER(a.name)='support' AND t.project_id=$3 AND t.agent_id=$2
         AND r.input->'workflow_context'->>'category'='support_case' AND r.input->'workflow_context'->>'support_case_id'=sc.id::text
       FOR UPDATE OF sc`, [runId, agentId, projectId],
    );
    const supportCase = result.rows[0];
    if (!supportCase) throw new Error("Status proposals must target the support case assigned to this Support run.");
    await client.query(`UPDATE support_cases SET status=$2,updated_at=NOW(),resolved_at=CASE WHEN $2='resolved' THEN NOW() ELSE NULL END WHERE id=$1`, [supportCase.id, status]);
    const taskStatus = status === "resolved" ? "done" : status === "waiting" ? "blocked" : "in_progress";
    await client.query("UPDATE tasks SET status=$2,updated_at=NOW() WHERE id=$1", [supportCase.task_id, taskStatus]);
    await client.query(`INSERT INTO events (source,event_type,title,severity,project_id,payload)
      VALUES ('support','support_case_updated','Owner-approved Support agent case update','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ support_case_id: supportCase.id, status, agent_run_id: runId, agent_id: agentId })]);
    return supportCase.id;
  },
};

const delegateTaskTool: AgentTool = {
  actionType: "delegate_task",
  permission: "request_task_delegation",
  parseProposal(value) {
    const title = boundedText(value.title, 200);
    const reason = boundedText(value.reason, 500);
    const assigneeAgentId = typeof value.assignee_agent_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.assignee_agent_id) ? value.assignee_agent_id : undefined;
    const priority = ["low", "normal", "high", "critical"].includes(String(value.priority)) ? value.priority as AgentActionRequest["priority"] : "normal";
    return value.type === "delegate_task" && title && reason && assigneeAgentId ? { title, reason, priority, assigneeAgentId } : null;
  },
  approvalPayload(value) {
    return { title: value.title, priority: value.priority, assignee_agent_id: value.assigneeAgentId };
  },
  approvalLabel(value) {
    return `Delegate task to report: ${value.title}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const title = boundedText(payload.title, 200);
    const targetId = typeof payload.assignee_agent_id === "string" ? payload.assignee_agent_id : "";
    const priority = ["low", "normal", "high", "critical"].includes(String(payload.priority)) ? String(payload.priority) : "";
    if (!title || !targetId || !priority || !projectId || !agentId) throw new Error("The approved delegation payload is invalid.");
    const report = await client.query(
      `SELECT 1 FROM agents manager JOIN agents child ON child.reports_to=manager.id
       JOIN agent_runs r ON r.agent_id=manager.id JOIN tasks source ON source.id=r.task_id
       WHERE manager.id=$1 AND child.id=$2 AND r.id=$3 AND source.project_id=$4 AND source.agent_id=manager.id`,
      [agentId, targetId, runId, projectId],
    );
    if (!report.rowCount) throw new Error("The assignee is no longer a direct report in this project.");
    const result = await client.query<{ id: string }>(
      `INSERT INTO tasks (project_id,agent_id,title,priority,status) VALUES ($1,$2,$3,$4,'todo') RETURNING id`,
      [projectId, targetId, title, priority],
    );
    const delegatedTaskId = result.rows[0].id;
    await client.query(
      `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,input)
       VALUES ($1,$2,'codex-cli','queued','Queued delegation execution.',$3::jsonb)`,
      [targetId, delegatedTaskId, JSON.stringify({ source: "owner_approved_delegation", delegated_by_agent_id: agentId })],
    );
    await client.query(
      `INSERT INTO events (project_id,source,event_type,title,severity,payload)
       VALUES ($1,'agent-router','agent_run_queued',$2,'info',$3::jsonb)`,
      [projectId, `Delegated task queued for ${title}`, JSON.stringify({ task_id: delegatedTaskId, agent_id: targetId, provider: "codex-cli" })],
    );
    return delegatedTaskId;
  },
};

const recordIncomeTool: AgentTool = {
  actionType: "record_income",
  permission: "request_financial_entry",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const description = boundedText(value.description, 180);
    const amountCents = Number(value.amount_cents);
    const transactionDate = typeof value.transaction_date === "string" ? value.transaction_date : "";
    const visibleEvidence = /payment|paid|receipt|completed order|purchase complete|transaction complete/i.test(`${reason} ${description}`);
    return value.type === "record_income" && reason.length >= 8 && description.length >= 3 && Number.isSafeInteger(amountCents)
      && amountCents > 0 && amountCents <= 999_999_999_999 && /^\d{4}-\d{2}-\d{2}$/.test(transactionDate) && visibleEvidence
      ? { reason, description, amountCents, transactionDate }
      : null;
  },
  approvalPayload(value) {
    return { direction: "income", amount_cents: value.amountCents, category: "sales", transaction_date: value.transactionDate, description: value.description };
  },
  approvalLabel(value) {
    return `Record sales income ${(Number(value.amountCents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} for ${value.transactionDate}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const amountCents = Number(payload.amount_cents);
    const date = typeof payload.transaction_date === "string" ? payload.transaction_date : "";
    const description = boundedText(payload.description, 180);
    if (payload.direction !== "income" || payload.category !== "sales" || !Number.isSafeInteger(amountCents)
      || amountCents <= 0 || amountCents > 999_999_999_999 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !description || !projectId || !agentId) {
      throw new Error("The approved sales income proposal is invalid.");
    }
    const source = await client.query<{ attention_item_id: string }>(
      `SELECT ai.id AS attention_item_id FROM agent_runs r JOIN tasks t ON t.id=r.task_id JOIN agents a ON a.id=r.agent_id
       JOIN attention_items ai ON ai.id=(r.input->>'attention_item_id')::uuid
       JOIN external_records er ON er.id=ai.external_record_id
       WHERE r.id=$1 AND r.agent_id=$2 AND LOWER(a.name)='finance' AND t.project_id=$3 AND r.input->'workflow_context'->>'category'='billing'
         AND ai.source='google-gmail' AND ai.attention_type='email_follow_up' AND er.provider='google-gmail'`,
      [runId, agentId, projectId],
    );
    const attentionItemId = source.rows[0]?.attention_item_id;
    if (!attentionItemId) throw new Error("Income proposals are limited to a Finance agent billing review from Gmail.");
    const result = await client.query<{ id: string }>(
      `INSERT INTO financial_transactions (project_id,transaction_date,direction,amount_cents,category,description,source_attention_item_id)
       VALUES ($1,$2,'income',$3,'sales',$4,$5)
       ON CONFLICT (source_attention_item_id) WHERE source_attention_item_id IS NOT NULL DO NOTHING RETURNING id`, [projectId, date, amountCents, description, attentionItemId],
    );
    if (!result.rows[0]) {
      const existing = await client.query<{ id: string }>("SELECT id FROM financial_transactions WHERE source_attention_item_id=$1", [attentionItemId]);
      return existing.rows[0].id;
    }
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('finance','financial_transaction_recorded','Approved sales income recorded','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ transaction_id: result.rows[0].id, agent_run_id: runId, agent_id: agentId, amount_cents: amountCents, category: "sales", transaction_date: date })],
    );
    return result.rows[0].id;
  },
};

const createSalesLeadTool: AgentTool = {
  actionType: "create_sales_lead",
  permission: "request_sales_lead",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const opportunityTitle = boundedText(value.opportunity_title, 180);
    return value.type === "create_sales_lead" && opportunityTitle.length >= 3 && reason.length >= 8
      ? { reason, opportunityTitle }
      : null;
  },
  approvalPayload(value) { return { opportunity_title: value.opportunityTitle }; },
  approvalLabel(value) { return `Add sales lead: ${value.opportunityTitle}`; },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const opportunityTitle = boundedText(payload.opportunity_title, 180);
    if (opportunityTitle.length < 3 || !projectId || !agentId) throw new Error("The approved sales lead proposal is invalid.");
    const source = await client.query<{ attention_item_id: string; contact_id: string }>(
      `SELECT ai.id AS attention_item_id,ai.contact_id FROM agent_runs r JOIN tasks t ON t.id=r.task_id JOIN agents a ON a.id=r.agent_id
       JOIN attention_items ai ON ai.id=(r.input->>'attention_item_id')::uuid
       JOIN external_records er ON er.id=ai.external_record_id
       WHERE r.id=$1 AND r.agent_id=$2 AND LOWER(a.name)='sales' AND t.project_id=$3 AND r.input->'workflow_context'->>'category'='sales'
         AND ai.source='google-gmail' AND ai.attention_type='email_follow_up' AND er.provider='google-gmail' AND ai.contact_id IS NOT NULL`,
      [runId, agentId, projectId],
    );
    const sourceItem = source.rows[0];
    if (!sourceItem) throw new Error("Lead proposals must come from a linked Gmail sales inquiry for this project.");
    const result = await client.query<{ id: string }>(
      `INSERT INTO sales_leads (project_id,contact_id,opportunity_title,stage,estimated_value_cents,follow_up_at,notes,source_attention_item_id)
       VALUES ($1,$2,$3,'new',0,NOW()+INTERVAL '1 day','Owner-approved lead detected from Gmail.',$4)
       ON CONFLICT (source_attention_item_id) WHERE source_attention_item_id IS NOT NULL DO NOTHING RETURNING id`,
      [projectId, sourceItem.contact_id, opportunityTitle, sourceItem.attention_item_id],
    );
    if (!result.rows[0]) {
      const existing = await client.query<{ id: string }>("SELECT id FROM sales_leads WHERE source_attention_item_id=$1", [sourceItem.attention_item_id]);
      return existing.rows[0].id;
    }
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('sales-pipeline','sales_lead_created','Owner-approved sales lead created','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ lead_id: result.rows[0].id, attention_item_id: sourceItem.attention_item_id, agent_run_id: runId, agent_id: agentId, stage: "new" })],
    );
    return result.rows[0].id;
  },
};

const sendEmailTool: AgentTool = {
  actionType: "send_email",
  permission: "request_email_outreach",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const recipient = boundedText(value.to, 254).toLowerCase();
    const subject = boundedText(value.subject, 180);
    const body = typeof value.body === "string" ? value.body.replace(/\r/g, "").trim().slice(0, 3500) : "";
    return value.type === "send_email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)
      && subject.length >= 3 && body.length >= 20 && reason.length >= 8
      ? { recipient, subject, body, reason } : null;
  },
  approvalPayload(value) { return { to: value.recipient, subject: value.subject, body: value.body }; },
  approvalLabel(value) { return `Send owner-reviewed sales email to ${value.recipient}: ${value.subject}`; },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const recipient = boundedText(payload.to, 254).toLowerCase();
    const subject = boundedText(payload.subject, 180);
    const body = typeof payload.body === "string" ? payload.body.trim().slice(0, 4000) : "";
    const address = process.env.COMPANYOS_POSTAL_ADDRESS?.trim();
    if (!address || !recipient || !subject || !body || !projectId || !agentId) {
      throw new Error("Email sending is disabled until COMPANYOS_POSTAL_ADDRESS is configured and the draft is valid.");
    }
    const approval = await client.query<{ id: string }>(
      `SELECT ap.id FROM approvals ap JOIN outbound_messages om ON om.approval_id=ap.id
       JOIN agent_runs r ON r.id=ap.agent_run_id JOIN tasks t ON t.id=r.task_id
       JOIN agents a ON a.id=r.agent_id
       WHERE ap.agent_run_id=$1 AND ap.agent_id=$2 AND ap.project_id=$3 AND ap.action_type='send_email'
         AND LOWER(a.name)='sales' AND om.recipient=$4 AND om.subject=$5 AND om.status='awaiting_approval'
         AND t.project_id=$3 LIMIT 1`, [runId, agentId, projectId, recipient, subject],
    );
    if (!approval.rows[0]) throw new Error("This email draft is no longer eligible to send.");
    const outbox = await client.query<{ id: string; contact_id: string; project_id: string }>(
      `SELECT id,contact_id,project_id FROM outbound_messages WHERE approval_id=$1 FOR UPDATE`, [approval.rows[0].id],
    );
    const message = outbox.rows[0];
    if (!message) throw new Error("The approved email draft could not be found.");
    const eligibility = await client.query(
      `SELECT 1 FROM sales_leads l JOIN contacts c ON c.id=l.contact_id
       WHERE c.id=$1 AND l.project_id=$2 AND l.stage IN ('new','qualified','proposal') AND LOWER(c.email)=LOWER($3)
         AND NOT EXISTS (SELECT 1 FROM contact_channel_preferences p WHERE p.contact_id=c.id AND p.channel='email' AND p.status='opted_out')`,
      [message.contact_id, projectId, recipient],
    );
    if (!eligibility.rowCount) throw new Error("Contact is no longer an active lead, email does not match, or the contact opted out.");
    const sent = await sendGoogleEmail({ idempotencyId: message.id, to: recipient, subject, body });
    await client.query(`UPDATE outbound_messages SET status='sent',provider_message_id=$2,provider_thread_id=$3,sent_at=NOW(),last_error=NULL WHERE id=$1`, [message.id, sent.id, sent.threadId]);
    await client.query(`INSERT INTO events (project_id,source,event_type,title,severity,payload) VALUES ($1,'sales','sales_email_sent','Approved sales email sent','info',$2::jsonb)`, [projectId, JSON.stringify({ outbound_message_id: message.id, contact_id: message.contact_id, agent_run_id: runId })]);
    return message.id;
  },
};

const registry = new Map<string, AgentTool>([
  [createTaskTool.actionType, createTaskTool],
  [updateTaskStatusTool.actionType, updateTaskStatusTool],
  [updateSupportCaseTool.actionType, updateSupportCaseTool],
  [delegateTaskTool.actionType, delegateTaskTool],
  [recordIncomeTool.actionType, recordIncomeTool],
  [createSalesLeadTool.actionType, createSalesLeadTool],
  [sendEmailTool.actionType, sendEmailTool],
]);

export function getAgentTool(actionType: unknown) {
  return typeof actionType === "string" ? registry.get(actionType) : undefined;
}
