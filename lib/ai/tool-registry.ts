import type { PoolClient } from "pg";
import { sendGoogleEmail } from "@/lib/integrations/google";
import { queueFirstResponse } from "@/lib/ai/first-response";
import { queueTaskExecution } from "@/lib/ai/queue-task-run";
import {
  createOrUpdateWordPressPage,
  createWordPressPost,
  replaceWordPressMenuItems,
  type WordPressSettingsUpdate,
  updateWordPressSiteSettings,
  uploadWordPressMedia,
} from "@/lib/integrations/wordpress";
import {
  getProxmoxContainer,
  getProxmoxContainerConfig,
  isProxmoxManageAction,
  type ProxmoxManageAction,
  rebootProxmoxContainer,
  resizeProxmoxContainer,
  shutdownProxmoxContainer,
  snapshotProxmoxContainer,
  startProxmoxContainer,
  stopProxmoxContainer,
} from "@/lib/integrations/proxmox";

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
  content?: string;
  contentType?: string;
  caption?: string;
  imagePrompt?: string;
  scheduledFor?: string;
  pageId?: number;
  slug?: string;
  pageStatus?: "draft" | "publish";
  sourceUrl?: string;
  altText?: string;
  menuId?: number;
  menuItems?: Array<{ title: string; url: string; parentIndex?: number }>;
  siteTitle?: string;
  siteDescription?: string;
  showOnFront?: "posts" | "page";
  pageOnFront?: number;
  proxmoxNode?: string;
  vmid?: number;
  containerName?: string;
  proxmoxAction?: ProxmoxManageAction;
  snapshotName?: string;
  cores?: number;
  memoryMb?: number;
  swapMb?: number;
  currentCores?: number;
  currentMemoryMb?: number;
  currentSwapMb?: number;
  generationPrompt?: string;
  imageCount?: number;
  contentItemId?: string;
  purpose?: "social post" | "website" | "other";
};

const CONTENT_TYPES = new Set(["post", "reel", "story", "article"]);

function boundedDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = value.trim().match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) return "";
  const parsed = new Date(`${match[0]}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? "" : match[0];
}

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

function boundedInt(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function boundedSlug(value: unknown): string {
  const slug = boundedText(value, 200).toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : "";
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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
    // Approval is the starting gun: queue the new task for autonomous
    // execution by its agent (Codex CLI, or a manual handoff for
    // manual-provider roles) instead of waiting for a manual dispatch.
    await queueTaskExecution(client, {
      projectId,
      agentId,
      taskId: result.rows[0].id,
      title,
      priority: priority as "low" | "normal" | "high" | "critical",
      source: "owner_approved_task",
    });
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
    await queueTaskExecution(client, {
      projectId,
      agentId: targetId,
      taskId: delegatedTaskId,
      title,
      priority: priority as "low" | "normal" | "high" | "critical",
      source: "owner_approved_delegation",
      inputExtras: { delegated_by_agent_id: agentId },
    });
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
    // Lead Desk speed rule: the new lead gets a first-response task at once.
    await queueFirstResponse(client, { projectId, leadId: result.rows[0].id, leadTitle: opportunityTitle });
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

const publishWordPressPostTool: AgentTool = {
  actionType: "publish_wordpress_post",
  permission: "request_wordpress_publish",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const title = boundedText(value.title, 200);
    const content = typeof value.content === "string" ? value.content.trim().slice(0, 50_000) : "";
    return value.type === "publish_wordpress_post" && title && content && reason
      ? { title, content, reason }
      : null;
  },
  approvalPayload(value) {
    return { title: value.title, content: value.content };
  },
  approvalLabel(value) {
    return `Publish WordPress draft: ${value.title}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const title = boundedText(payload.title, 200);
    const content = typeof payload.content === "string" ? payload.content.trim() : "";
    if (!title || !content || !projectId) throw new Error("The approved WordPress post payload is invalid.");
    const result = await createWordPressPost({ title, content, status: "draft" });
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('wordpress','wordpress_post_created','WordPress draft created from approved agent action','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ post_id: result.id, link: result.link, agent_run_id: runId, agent_id: agentId, title })],
    );
    return String(result.id);
  },
};

const publishWordPressPageTool: AgentTool = {
  actionType: "publish_wordpress_page",
  permission: "request_wordpress_manage",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const title = boundedText(value.title, 200);
    const content = typeof value.content === "string" ? value.content.trim().slice(0, 50_000) : "";
    const pageId = boundedInt(value.page_id, 1, 2_147_483_647);
    const slug = boundedSlug(value.slug);
    const pageStatus = value.status === "publish" ? "publish" : "draft";
    return value.type === "publish_wordpress_page" && content && reason && (title || pageId)
      ? { title, content, reason, pageId, slug, pageStatus }
      : null;
  },
  approvalPayload(value) {
    return {
      page_id: value.pageId ?? null,
      slug: value.slug ?? "",
      title: value.title,
      content: value.content,
      status: value.pageStatus ?? "draft",
    };
  },
  approvalLabel(value) {
    const live = value.pageStatus === "publish";
    if (value.pageId) return `Update WordPress page #${value.pageId} (${live ? "LIVE" : "draft"}): ${value.title}`;
    return `Publish WordPress page ${live ? "LIVE" : "draft"}: ${value.title}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const title = boundedText(payload.title, 200);
    const content = typeof payload.content === "string" ? payload.content.trim() : "";
    const pageId = boundedInt(payload.page_id, 1, 2_147_483_647);
    const slug = boundedSlug(payload.slug);
    const status = payload.status === "publish" ? "publish" : "draft";
    if (!content || !(title || pageId) || !projectId) throw new Error("The approved WordPress page payload is invalid.");
    const { page, created } = await createOrUpdateWordPressPage({ pageId, slug: slug || undefined, title, content, status });
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('wordpress','wordpress_page_published','WordPress page saved from approved agent action','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ page_id: page.id, link: page.link, created, status, agent_run_id: runId, agent_id: agentId, title })],
    );
    return String(page.id);
  },
};

const uploadWordPressMediaTool: AgentTool = {
  actionType: "upload_wordpress_media",
  permission: "request_wordpress_manage",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const sourceUrl = boundedText(value.source_url, 1000);
    const title = boundedText(value.title, 200);
    const altText = boundedText(value.alt_text, 300);
    return value.type === "upload_wordpress_media" && sourceUrl && isHttpUrl(sourceUrl) && reason
      ? { sourceUrl, title, altText, reason }
      : null;
  },
  approvalPayload(value) {
    return { source_url: value.sourceUrl, title: value.title ?? "", alt_text: value.altText ?? "" };
  },
  approvalLabel(value) {
    return `Upload media to WordPress: ${value.title || value.sourceUrl}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const sourceUrl = boundedText(payload.source_url, 1000);
    const title = boundedText(payload.title, 200);
    const altText = boundedText(payload.alt_text, 300);
    if (!sourceUrl || !isHttpUrl(sourceUrl) || !projectId) throw new Error("The approved WordPress media payload is invalid.");
    // The source URL was visible in the approval; the adapter re-checks
    // that it is a public http(s) host before fetching it server-side.
    const media = await uploadWordPressMedia({ sourceUrl, title: title || undefined, altText: altText || undefined });
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('wordpress','wordpress_media_uploaded','WordPress media uploaded from approved agent action','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ media_id: media.id, media_url: media.sourceUrl, link: media.link, source_url: sourceUrl, agent_run_id: runId, agent_id: agentId, title })],
    );
    return String(media.id);
  },
};

function describeSettingsChanges(value: AgentActionRequest): string[] {
  const parts: string[] = [];
  if (value.siteTitle !== undefined) parts.push(`site title → "${value.siteTitle}"`);
  if (value.siteDescription !== undefined) parts.push(`tagline → "${value.siteDescription}"`);
  if (value.showOnFront !== undefined) parts.push(`homepage shows → ${value.showOnFront === "page" ? "a static page" : "latest posts"}`);
  if (value.pageOnFront !== undefined) parts.push(`homepage page → #${value.pageOnFront}`);
  return parts;
}

const updateWordPressSettingsTool: AgentTool = {
  actionType: "update_wordpress_settings",
  permission: "request_wordpress_manage",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const siteTitle = typeof value.title === "string" ? boundedText(value.title, 200) : undefined;
    const siteDescription = typeof value.description === "string" ? boundedText(value.description, 300) : undefined;
    const showOnFront = value.show_on_front === "page" || value.show_on_front === "posts" ? value.show_on_front : undefined;
    const pageOnFront = boundedInt(value.page_on_front, 1, 2_147_483_647);
    const changes: AgentActionRequest = { reason, siteTitle, siteDescription, showOnFront, pageOnFront };
    return value.type === "update_wordpress_settings" && reason && describeSettingsChanges(changes).length ? changes : null;
  },
  approvalPayload(value) {
    return {
      ...(value.siteTitle !== undefined ? { title: value.siteTitle } : {}),
      ...(value.siteDescription !== undefined ? { description: value.siteDescription } : {}),
      ...(value.showOnFront !== undefined ? { show_on_front: value.showOnFront } : {}),
      ...(value.pageOnFront !== undefined ? { page_on_front: value.pageOnFront } : {}),
    };
  },
  approvalLabel(value) {
    // Settings touch the whole site, so the approval spells out the exact
    // diff the owner is approving — no hidden fields ride along.
    return `Update WordPress site settings: ${describeSettingsChanges(value).join("; ")}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const update: WordPressSettingsUpdate = {
      title: typeof payload.title === "string" ? boundedText(payload.title, 200) : undefined,
      description: typeof payload.description === "string" ? boundedText(payload.description, 300) : undefined,
      showOnFront: payload.show_on_front === "page" ? "page" : payload.show_on_front === "posts" ? "posts" : undefined,
      pageOnFront: boundedInt(payload.page_on_front, 1, 2_147_483_647),
    };
    if (!describeSettingsChanges({ reason: "", siteTitle: update.title, siteDescription: update.description, showOnFront: update.showOnFront, pageOnFront: update.pageOnFront }).length || !projectId) {
      throw new Error("The approved WordPress settings payload is invalid.");
    }
    const settings = await updateWordPressSiteSettings(update);
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('wordpress','wordpress_settings_updated','WordPress site settings updated from approved agent action','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ changes: update, resulting_title: settings.title, resulting_show_on_front: settings.showOnFront, agent_run_id: runId, agent_id: agentId })],
    );
    return "settings";
  },
};

function parseMenuItems(raw: unknown): NonNullable<AgentActionRequest["menuItems"]> | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const menuItems: NonNullable<AgentActionRequest["menuItems"]> = [];
  for (const [index, entry] of raw.slice(0, 30).entries()) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const title = boundedText(item.title, 100);
    const url = boundedText(item.url, 500);
    const parentIndex = boundedInt(item.parent_index, 0, 29);
    if (!title || !url || !isHttpUrl(url)) return null;
    if (parentIndex !== undefined && parentIndex >= index) return null;
    menuItems.push({ title, url, ...(parentIndex !== undefined ? { parentIndex } : {}) });
  }
  return menuItems.length ? menuItems : null;
}

const updateWordPressMenuTool: AgentTool = {
  actionType: "update_wordpress_menu",
  permission: "request_wordpress_manage",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const menuId = boundedInt(value.menu_id, 1, 2_147_483_647);
    const menuItems = parseMenuItems(value.items);
    return value.type === "update_wordpress_menu" && menuId && menuItems && reason
      ? { menuId, menuItems, reason }
      : null;
  },
  approvalPayload(value) {
    return {
      menu_id: value.menuId,
      items: (value.menuItems ?? []).map((item) => ({
        title: item.title,
        url: item.url,
        ...(item.parentIndex !== undefined ? { parent_index: item.parentIndex } : {}),
      })),
    };
  },
  approvalLabel(value) {
    const titles = (value.menuItems ?? []).map((item) => item.title).join(", ");
    return `Replace WordPress menu #${value.menuId} items (${value.menuItems?.length ?? 0}): ${titles.slice(0, 160)}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const menuId = boundedInt(payload.menu_id, 1, 2_147_483_647);
    const menuItems = parseMenuItems(payload.items);
    if (!menuId || !menuItems || !projectId) throw new Error("The approved WordPress menu payload is invalid.");
    const result = await replaceWordPressMenuItems(menuId, menuItems);
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('wordpress','wordpress_menu_updated','WordPress menu replaced from approved agent action','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ menu_id: result.menuId, item_count: result.itemCount, agent_run_id: runId, agent_id: agentId })],
    );
    return String(result.menuId);
  },
};

function boundedNodeName(value: unknown): string {
  const node = boundedText(value, 63);
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(node) ? node : "";
}

function boundedSnapshotName(value: unknown): string {
  const name = boundedText(value, 40);
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) && name.toLowerCase() !== "current" ? name : "";
}

const PROXMOX_CORES_MIN = 1;
const PROXMOX_CORES_MAX = 64;
const PROXMOX_MEMORY_MIN_MB = 128;
const PROXMOX_MEMORY_MAX_MB = 131_072;
const PROXMOX_SWAP_MAX_MB = 65_536;

function proxmoxResizeParts(value: AgentActionRequest): string[] {
  const parts: string[] = [];
  if (value.cores !== undefined && value.currentCores !== undefined && value.cores !== value.currentCores) {
    parts.push(`cores ${value.currentCores} → ${value.cores}`);
  }
  if (value.memoryMb !== undefined && value.currentMemoryMb !== undefined && value.memoryMb !== value.currentMemoryMb) {
    parts.push(`memory ${value.currentMemoryMb} MB → ${value.memoryMb} MB`);
  }
  if (value.swapMb !== undefined && value.currentSwapMb !== undefined && value.swapMb !== value.currentSwapMb) {
    parts.push(`swap ${value.currentSwapMb} MB → ${value.swapMb} MB`);
  }
  return parts;
}

function proxmoxTargetLabel(value: AgentActionRequest): string {
  return `LXC ${value.vmid}${value.containerName ? ` "${value.containerName}"` : ""} on ${value.proxmoxNode}`;
}

const manageProxmoxContainerTool: AgentTool = {
  actionType: "manage_proxmox_container",
  permission: "request_proxmox_manage",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const proxmoxNode = boundedNodeName(value.node);
    const vmid = boundedInt(value.vmid, 100, 999_999_999);
    const containerName = boundedText(value.container_name, 120);
    const rawAction = value.action;
    const action: ProxmoxManageAction | undefined = isProxmoxManageAction(rawAction) ? rawAction : undefined;
    if (value.type !== "manage_proxmox_container" || !reason || !proxmoxNode || !vmid || !action) return null;
    if (action === "snapshot") {
      const snapshotName = boundedSnapshotName(value.snapshot_name);
      return snapshotName ? { reason, proxmoxNode, vmid, containerName, proxmoxAction: action, snapshotName } : null;
    }
    if (action === "resize") {
      const cores = boundedInt(value.cores, PROXMOX_CORES_MIN, PROXMOX_CORES_MAX);
      const memoryMb = boundedInt(value.memory_mb, PROXMOX_MEMORY_MIN_MB, PROXMOX_MEMORY_MAX_MB);
      const swapMb = boundedInt(value.swap_mb, 0, PROXMOX_SWAP_MAX_MB);
      const currentCores = boundedInt(value.current_cores, PROXMOX_CORES_MIN, PROXMOX_CORES_MAX);
      const currentMemoryMb = boundedInt(value.current_memory_mb, PROXMOX_MEMORY_MIN_MB, PROXMOX_MEMORY_MAX_MB);
      const currentSwapMb = boundedInt(value.current_swap_mb, 0, PROXMOX_SWAP_MAX_MB);
      const candidate: AgentActionRequest = {
        reason, proxmoxNode, vmid, containerName, proxmoxAction: action,
        cores, memoryMb, swapMb, currentCores, currentMemoryMb, currentSwapMb,
      };
      const anyChange = cores !== undefined || memoryMb !== undefined || swapMb !== undefined;
      const missingBefore = (cores !== undefined && currentCores === undefined)
        || (memoryMb !== undefined && currentMemoryMb === undefined)
        || (swapMb !== undefined && currentSwapMb === undefined);
      // A resize the owner cannot see as an exact before → after diff is
      // not a valid proposal: every changed field needs its before-value,
      // and at least one field must actually change.
      if (!anyChange || missingBefore || !proxmoxResizeParts(candidate).length) return null;
      return {
        reason, proxmoxNode, vmid, containerName, proxmoxAction: action,
        ...(cores !== undefined && cores !== currentCores ? { cores, currentCores } : {}),
        ...(memoryMb !== undefined && memoryMb !== currentMemoryMb ? { memoryMb, currentMemoryMb } : {}),
        ...(swapMb !== undefined && swapMb !== currentSwapMb ? { swapMb, currentSwapMb } : {}),
      };
    }
    return { reason, proxmoxNode, vmid, containerName, proxmoxAction: action };
  },
  approvalPayload(value) {
    return {
      node: value.proxmoxNode,
      vmid: value.vmid,
      container_name: value.containerName ?? "",
      action: value.proxmoxAction,
      ...(value.snapshotName ? { snapshot_name: value.snapshotName } : {}),
      ...(value.cores !== undefined ? { cores: value.cores, current_cores: value.currentCores } : {}),
      ...(value.memoryMb !== undefined ? { memory_mb: value.memoryMb, current_memory_mb: value.currentMemoryMb } : {}),
      ...(value.swapMb !== undefined ? { swap_mb: value.swapMb, current_swap_mb: value.currentSwapMb } : {}),
    };
  },
  approvalLabel(value) {
    const target = proxmoxTargetLabel(value);
    switch (value.proxmoxAction) {
      case "start": return `Start Proxmox ${target}`;
      case "shutdown": return `Shut down Proxmox ${target}`;
      case "stop": return `Stop Proxmox ${target}`;
      case "reboot": return `Reboot Proxmox ${target}`;
      case "snapshot": return `Snapshot Proxmox ${target} as "${value.snapshotName}"`;
      case "resize": return `Resize Proxmox ${target}: ${proxmoxResizeParts(value).join("; ")}`;
      default: return `Manage Proxmox ${target}`;
    }
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const node = boundedNodeName(payload.node);
    const vmid = boundedInt(payload.vmid, 100, 999_999_999);
    const containerName = boundedText(payload.container_name, 120);
    const rawAction = payload.action;
    // Defense in depth: the action is re-validated against the v1
    // allowlist at execution time, not just when the proposal was
    // recorded — a tampered or legacy payload cannot widen the surface
    // beyond start / shutdown / stop / reboot / snapshot / resize.
    const action: ProxmoxManageAction | undefined = isProxmoxManageAction(rawAction) ? rawAction : undefined;
    if (!node || !vmid || !action || !projectId) throw new Error("The approved Proxmox payload is invalid.");
    const container = await getProxmoxContainer(node, vmid);
    if (!container) throw new Error(`Proxmox container ${vmid} was not found on node ${node}; approval was not applied.`);
    if (containerName && container.name && container.name !== containerName) {
      throw new Error(`Proxmox container ${vmid} is now named "${container.name}", not "${containerName}"; approval was not applied.`);
    }
    let detail = "";
    if (action === "resize") {
      const cores = boundedInt(payload.cores, PROXMOX_CORES_MIN, PROXMOX_CORES_MAX);
      const memoryMb = boundedInt(payload.memory_mb, PROXMOX_MEMORY_MIN_MB, PROXMOX_MEMORY_MAX_MB);
      const swapMb = boundedInt(payload.swap_mb, 0, PROXMOX_SWAP_MAX_MB);
      const currentCores = boundedInt(payload.current_cores, PROXMOX_CORES_MIN, PROXMOX_CORES_MAX);
      const currentMemoryMb = boundedInt(payload.current_memory_mb, PROXMOX_MEMORY_MIN_MB, PROXMOX_MEMORY_MAX_MB);
      const currentSwapMb = boundedInt(payload.current_swap_mb, 0, PROXMOX_SWAP_MAX_MB);
      const candidate: AgentActionRequest = {
        reason: "", proxmoxNode: node, vmid, containerName, proxmoxAction: action,
        cores, memoryMb, swapMb, currentCores, currentMemoryMb, currentSwapMb,
      };
      const missingBefore = (cores !== undefined && currentCores === undefined)
        || (memoryMb !== undefined && currentMemoryMb === undefined)
        || (swapMb !== undefined && currentSwapMb === undefined);
      if (missingBefore || !proxmoxResizeParts(candidate).length) throw new Error("The approved Proxmox resize payload is invalid.");
      const live = await getProxmoxContainerConfig(node, vmid);
      if ((cores !== undefined && live.cores !== currentCores)
        || (memoryMb !== undefined && live.memoryMb !== currentMemoryMb)
        || (swapMb !== undefined && live.swapMb !== currentSwapMb)) {
        throw new Error("The container's live config no longer matches the approved before-values; approval was not applied.");
      }
      await resizeProxmoxContainer(node, vmid, { cores, memoryMb, swapMb });
      detail = proxmoxResizeParts(candidate).join("; ");
    } else if (action === "snapshot") {
      const snapshotName = boundedSnapshotName(payload.snapshot_name);
      if (!snapshotName) throw new Error("The approved Proxmox snapshot payload is invalid.");
      await snapshotProxmoxContainer(node, vmid, snapshotName, "Created by CompanyOS from an owner-approved DevOps proposal.");
      detail = `snapshot "${snapshotName}"`;
    } else {
      const taskId = action === "start"
        ? await startProxmoxContainer(node, vmid)
        : action === "shutdown"
          ? await shutdownProxmoxContainer(node, vmid)
          : action === "stop"
            ? await stopProxmoxContainer(node, vmid)
            : await rebootProxmoxContainer(node, vmid);
      detail = `proxmox task ${taskId}`;
    }
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('proxmox','proxmox_container_managed','Proxmox container action executed from approved agent action','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ node, vmid, container_name: container.name || containerName, action, detail, agent_run_id: runId, agent_id: agentId })],
    );
    return `${node}/${vmid}`;
  },
};

const createContentItemTool: AgentTool = {
  actionType: "create_content_item",
  permission: "request_content_item",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const title = boundedText(value.title, 160);
    const contentType = typeof value.content_type === "string" && CONTENT_TYPES.has(value.content_type) ? value.content_type : "";
    const caption = boundedText(value.caption, 2200);
    const imagePrompt = boundedText(value.image_prompt, 500);
    const scheduledFor = boundedDate(value.scheduled_for);
    return value.type === "create_content_item" && title.length >= 3 && contentType && reason.length >= 8
      ? { reason, title, contentType, caption, imagePrompt, scheduledFor }
      : null;
  },
  approvalPayload(value) {
    return { title: value.title, content_type: value.contentType, caption: value.caption ?? "", image_prompt: value.imagePrompt ?? "", scheduled_for: value.scheduledFor ?? "" };
  },
  approvalLabel(value) { return `Add to content planner (${value.contentType}): ${value.title}`; },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const title = boundedText(payload.title, 160);
    const contentType = typeof payload.content_type === "string" && CONTENT_TYPES.has(payload.content_type) ? payload.content_type : "";
    if (title.length < 3 || !contentType || !projectId) throw new Error("The approved content proposal is invalid.");
    const agent = agentId ? await client.query<{ name: string }>("SELECT name FROM agents WHERE id=$1", [agentId]) : null;
    const result = await client.query<{ id: string }>(
      `INSERT INTO content_items (project_id,type,title,caption,image_prompt,status,scheduled_for,created_by)
       VALUES ($1,$2,$3,$4,$5,'in_review',$6,$7) RETURNING id`,
      [projectId, contentType, title, boundedText(payload.caption, 2200), boundedText(payload.image_prompt, 500),
        boundedDate(payload.scheduled_for) || null, agent?.rows[0]?.name ?? "agent"],
    );
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('content-planner','content_item_created','Owner-approved content added to the planner','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ content_item_id: result.rows[0].id, agent_run_id: runId, agent_id: agentId, type: contentType, title })],
    );
    return result.rows[0].id;
  },
};

const IMAGE_PURPOSES = new Set(["social post", "website", "other"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const generateImageTool: AgentTool = {
  actionType: "generate_image",
  permission: "request_image_generation",
  parseProposal(value) {
    const reason = boundedText(value.reason, 500);
    const generationPrompt = boundedText(value.prompt, 1000);
    const imageCount = boundedInt(value.count, 1, 4) ?? 3;
    const purpose = typeof value.purpose === "string" && IMAGE_PURPOSES.has(value.purpose)
      ? value.purpose as AgentActionRequest["purpose"]
      : "other";
    const contentItemId = typeof value.content_item_id === "string" && UUID_PATTERN.test(value.content_item_id)
      ? value.content_item_id
      : undefined;
    // A proposal that names a content item with a malformed id is invalid
    // rather than silently unattached: the owner approves what they see.
    if (value.content_item_id !== undefined && value.content_item_id !== null && value.content_item_id !== "" && !contentItemId) return null;
    return value.type === "generate_image" && generationPrompt.length >= 3 && reason.length >= 8
      ? { reason, generationPrompt, imageCount, purpose, ...(contentItemId ? { contentItemId } : {}) }
      : null;
  },
  approvalPayload(value) {
    return {
      prompt: value.generationPrompt,
      count: value.imageCount ?? 3,
      purpose: value.purpose ?? "other",
      content_item_id: value.contentItemId ?? null,
    };
  },
  approvalLabel(value) {
    return `Generate image (×${value.imageCount ?? 3}, ${value.purpose ?? "other"}): ${(value.generationPrompt ?? "").slice(0, 120)}`;
  },
  async execute(client, projectId, agentId, rawPayload, runId) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
    const generationPrompt = boundedText(payload.prompt, 1000);
    const imageCount = boundedInt(payload.count, 1, 4) ?? 3;
    const purpose = typeof payload.purpose === "string" && IMAGE_PURPOSES.has(payload.purpose) ? payload.purpose : "other";
    const contentItemId = typeof payload.content_item_id === "string" && UUID_PATTERN.test(payload.content_item_id)
      ? payload.content_item_id
      : null;
    if (generationPrompt.length < 3 || !agentId) throw new Error("The approved image generation payload is invalid.");
    // Same assignment guard as create_task: the generation must trace
    // back to a run of this agent on a task in the same project. The
    // project may be null: image requests are often company-wide or
    // client work (e.g. an ad design) that belongs to no single project,
    // so the guard compares with IS NOT DISTINCT FROM instead of
    // requiring a project outright.
    const assignment = await client.query(
      `SELECT 1 FROM agent_runs r JOIN tasks t ON t.id=r.task_id
       WHERE r.id=$1 AND r.agent_id=$2 AND t.project_id IS NOT DISTINCT FROM $3 AND t.agent_id=$2`,
      [runId, agentId, projectId],
    );
    if (!assignment.rowCount) throw new Error("The original task is no longer assigned to this agent in the same project.");
    if (contentItemId) {
      const item = await client.query("SELECT 1 FROM content_items WHERE id=$1 AND project_id=$2", [contentItemId, projectId]);
      if (!item.rowCount) throw new Error("The content item named in the approved image proposal no longer exists in this project.");
    }
    // Nothing is generated here: generation happens on the worker host,
    // where the worker runs the imagegen CLI (GPT Image models) for the
    // queued run. Approval queues a normal execution task for the same
    // agent; the queued run's input carries the image_generation spec
    // the worker reads, and the generated URLs come back in that run's
    // result (and in the content item's design-studio options when one
    // is named).
    const title = boundedText(`Generate image: ${generationPrompt}`, 200);
    const result = await client.query<{ id: string }>(
      `INSERT INTO tasks (project_id,agent_id,title,priority,status) VALUES ($1,$2,$3,'normal','todo') RETURNING id`,
      [projectId, agentId, title],
    );
    const taskId = result.rows[0].id;
    await queueTaskExecution(client, {
      projectId,
      agentId,
      taskId,
      title,
      priority: "normal",
      source: "owner_approved_image_generation",
      inputExtras: {
        image_generation: {
          prompt: generationPrompt,
          count: imageCount,
          purpose,
          content_item_id: contentItemId,
          requested_by_run_id: runId,
        },
      },
    });
    await client.query(
      `INSERT INTO events (source,event_type,title,severity,project_id,payload)
       VALUES ('images','image_generation_queued','Image generation queued for the Codex worker','info',$1,$2::jsonb)`,
      [projectId, JSON.stringify({ task_id: taskId, content_item_id: contentItemId, count: imageCount, purpose, agent_run_id: runId, agent_id: agentId })],
    );
    return taskId;
  },
};

const registry = new Map<string, AgentTool>([
  [generateImageTool.actionType, generateImageTool],
  [createContentItemTool.actionType, createContentItemTool],
  [createTaskTool.actionType, createTaskTool],
  [updateTaskStatusTool.actionType, updateTaskStatusTool],
  [updateSupportCaseTool.actionType, updateSupportCaseTool],
  [delegateTaskTool.actionType, delegateTaskTool],
  [recordIncomeTool.actionType, recordIncomeTool],
  [createSalesLeadTool.actionType, createSalesLeadTool],
  [sendEmailTool.actionType, sendEmailTool],
  [publishWordPressPostTool.actionType, publishWordPressPostTool],
  [publishWordPressPageTool.actionType, publishWordPressPageTool],
  [uploadWordPressMediaTool.actionType, uploadWordPressMediaTool],
  [updateWordPressSettingsTool.actionType, updateWordPressSettingsTool],
  [updateWordPressMenuTool.actionType, updateWordPressMenuTool],
  [manageProxmoxContainerTool.actionType, manageProxmoxContainerTool],
]);

export function getAgentTool(actionType: unknown) {
  return typeof actionType === "string" ? registry.get(actionType) : undefined;
}
