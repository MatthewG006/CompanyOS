import type { PoolClient } from "pg";
import { getAgentTool } from "@/lib/ai/tool-registry";

type ProposedAction = { type?: unknown; title?: unknown; priority?: unknown; reason?: unknown; status?: unknown; assignee_agent_id?: unknown };

function parseProposals(responseText: string): ProposedAction[] {
  const start = responseText.indexOf("{");
  const end = responseText.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(responseText.slice(start, end + 1)) as { proposed_actions?: unknown };
    return Array.isArray(parsed.proposed_actions) ? parsed.proposed_actions.slice(0, 3) : [];
  } catch {
    return [];
  }
}

export async function recordAgentProposals(client: PoolClient, runId: string, responseText: string) {
  const proposals = parseProposals(responseText);
  if (!proposals.length) return 0;
  const runResult = await client.query<{ agent_id: string | null; agent_name: string | null; project_id: string | null; task_title: string | null; allowed_actions: unknown; memory_scope: unknown; input: Record<string, unknown>; direct_reports: Array<{ id: string; name: string }> }>(
    `SELECT r.agent_id,a.name AS agent_name,a.allowed_actions,a.memory_scope,r.input,t.project_id,t.title AS task_title,
       COALESCE((SELECT json_agg(json_build_object('id',child.id::text,'name',child.name)) FROM agents child WHERE child.reports_to=a.id),'[]'::json) AS direct_reports
     FROM agent_runs r LEFT JOIN agents a ON a.id=r.agent_id LEFT JOIN tasks t ON t.id=r.task_id
     WHERE r.id=$1`, [runId],
  );
  const run = runResult.rows[0];
  if (!run?.agent_id || !run.project_id || !Array.isArray(run.allowed_actions)) return 0;

  let recorded = 0;
  for (const [index, proposal] of proposals.entries()) {
    if (!proposal || typeof proposal !== "object") continue;
    const tool = getAgentTool(proposal.type);
    if (!tool || !run.allowed_actions.includes(tool.permission)) continue;
    const workflowContext = run.input?.workflow_context;
    if (tool.actionType === "record_income" && (run.agent_name?.toLowerCase() !== "finance" || !workflowContext || typeof workflowContext !== "object" || (workflowContext as Record<string, unknown>).category !== "billing")) continue;
    if (tool.actionType === "create_sales_lead" && (run.agent_name?.toLowerCase() !== "sales" || !workflowContext || typeof workflowContext !== "object" || (workflowContext as Record<string, unknown>).category !== "sales")) continue;
    if (tool.actionType === "send_email" && (run.agent_name?.toLowerCase() !== "sales"
      || !run.allowed_actions.includes("request_email_outreach")
      || !Array.isArray(run.memory_scope) || !run.memory_scope.includes("sales")
      || !workflowContext || typeof workflowContext !== "object"
      || !["sales", "sales_followup"].includes(String((workflowContext as Record<string, unknown>).category))
      || !process.env.COMPANYOS_POSTAL_ADDRESS?.trim())) continue;
    if (tool.actionType === "update_support_case" && (run.agent_name?.toLowerCase() !== "support"
      || !Array.isArray(run.memory_scope) || !run.memory_scope.includes("support")
      || !workflowContext || typeof workflowContext !== "object" || (workflowContext as Record<string, unknown>).category !== "support_case")) continue;
    const request = tool.parseProposal(proposal as Record<string, unknown>);
    if (!request) continue;
    const directReport = run.direct_reports.find((child) => child.id === request.assigneeAgentId);
    if (tool.actionType === "delegate_task" && !directReport) continue;
    const targetLabel = directReport ? ` → ${directReport.name}` : "";
    const approvalAction = `${tool.approvalLabel(request)}${targetLabel} · for: ${run.task_title ?? "assigned task"}`;
    const result = await client.query<{ id: string }>(
      `INSERT INTO approvals (project_id,requested_by,action,risk_level,reason,agent_run_id,agent_id,action_type,proposal_index,payload)
       VALUES ($1,$2,$3,'high',$4,$5,$6,$9,$7,$8::jsonb)
       ON CONFLICT (agent_run_id,proposal_index) WHERE agent_run_id IS NOT NULL AND proposal_index IS NOT NULL DO NOTHING RETURNING id`,
      [run.project_id, run.agent_name ?? "CompanyOS agent", approvalAction, request.reason, runId, run.agent_id, index, JSON.stringify(tool.approvalPayload(request)), tool.actionType],
    );
    if (result.rowCount) {
      if (tool.actionType === "send_email") {
        const payload = tool.approvalPayload(request);
        const context = workflowContext as Record<string, unknown>;
        const followupLeadId = context.category === "sales_followup" && typeof context.sales_lead_id === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.sales_lead_id)
          ? context.sales_lead_id : null;
        if (context.category === "sales_followup" && !followupLeadId) {
          await client.query("DELETE FROM approvals WHERE id=$1", [result.rows[0].id]);
          continue;
        }
        const postalAddress = process.env.COMPANYOS_POSTAL_ADDRESS?.trim();
        if (!postalAddress) { await client.query("DELETE FROM approvals WHERE id=$1", [result.rows[0].id]); continue; }
        const finalBody = `${payload.body}\n\n${postalAddress}\nTo stop receiving these emails, reply with “unsubscribe”.`;
        const target = await client.query<{ id: string }>(
          `SELECT c.id FROM contacts c JOIN sales_leads l ON l.contact_id=c.id
           WHERE l.project_id=$1 AND l.stage IN ('new','qualified','proposal') AND LOWER(c.email)=LOWER($2)
             AND ($3::uuid IS NULL OR l.id=$3)
             AND NOT EXISTS (SELECT 1 FROM contact_channel_preferences p WHERE p.contact_id=c.id AND p.channel='email' AND p.status='opted_out')
           ORDER BY l.updated_at DESC LIMIT 1`, [run.project_id, payload.to, followupLeadId],
        );
        const contactId = target.rows[0]?.id;
        if (!contactId) { await client.query("DELETE FROM approvals WHERE id=$1", [result.rows[0].id]); continue; }
        await client.query(
          `INSERT INTO outbound_messages (approval_id,project_id,contact_id,channel,recipient,subject,body)
           VALUES ($1,$2,$3,'email',$4,$5,$6)`,
          [result.rows[0].id, run.project_id, contactId, payload.to, payload.subject, finalBody],
        );
        await client.query("UPDATE approvals SET payload=$2::jsonb WHERE id=$1", [result.rows[0].id, JSON.stringify({ ...payload, body: finalBody })]);
      }
      recorded += 1;
      await client.query(
        `INSERT INTO events (project_id,source,event_type,title,severity,payload)
         VALUES ($1,'agent-router','agent_action_requested',$2,'info',$3::jsonb)`,
        [run.project_id, `Agent action awaits approval: ${tool.approvalLabel(request)}`, JSON.stringify({ run_id: runId, agent_id: run.agent_id, action_type: tool.actionType })],
      );
    }
  }
  return recorded;
}
