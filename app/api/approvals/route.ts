import { NextResponse } from "next/server";
import { databaseAvailable, transaction } from "@/lib/db";
import { getDashboardData } from "@/lib/data";
import { getAgentTool } from "@/lib/ai/tool-registry";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

function denied() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  const data = await getDashboardData();
  return NextResponse.json({ approvals: data.approvals, source: data.source });
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) {
    return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  }

  try {
    const body = await request.json();
    const id = typeof body?.id === "string" ? body.id : "";
    const status = body?.status === "approved" || body?.status === "rejected" ? body.status : "";
    if (!id || !status) return NextResponse.json({ error: "id and status=approved|rejected are required." }, { status: 400 });

    const decision = await transaction(async (client) => {
      const pending = await client.query<{ id: string; action: string; project_id: string | null; agent_id: string | null; agent_run_id: string | null; action_type: string | null; payload: unknown }>(
        `SELECT id,action,project_id,agent_id,agent_run_id,action_type,payload FROM approvals WHERE id=$1 AND status='pending' FOR UPDATE`, [id],
      );
      const approval = pending.rows[0];
      if (!approval) return null;

      let affectedEntityId: string | null = null;
      const tool = getAgentTool(approval.action_type);
      if (status === "approved" && approval.action_type && !tool) return { unsupported: true as const };
      if (status === "approved" && tool) {
        const permissions = approval.agent_id
          ? await client.query<{ allowed_actions: unknown }>("SELECT allowed_actions FROM agents WHERE id=$1", [approval.agent_id])
          : { rows: [] as Array<{ allowed_actions: unknown }> };
        if (!Array.isArray(permissions.rows[0]?.allowed_actions) || !permissions.rows[0].allowed_actions.includes(tool.permission)) {
          return { forbidden: true as const };
        }
        if (approval.action_type === "send_email") {
          const queued = await client.query<{ id: string }>(
            `UPDATE outbound_messages SET status='queued',updated_at=NOW(),next_attempt_at=NOW()
             WHERE approval_id=$1 AND status='awaiting_approval' RETURNING id`, [id],
          );
          if (!queued.rows[0]) return { unsupported: true as const };
          affectedEntityId = queued.rows[0].id;
        } else {
          affectedEntityId = await tool.execute(client, approval.project_id, approval.agent_id, approval.payload, approval.agent_run_id ?? "");
        }
      }

      await client.query("UPDATE approvals SET status=$2,decided_at=NOW() WHERE id=$1", [id, status]);
      if (approval.action_type === "send_email" && status === "rejected") {
        await client.query("UPDATE outbound_messages SET status='rejected' WHERE approval_id=$1 AND status='awaiting_approval'", [id]);
      }
      await client.query(
        `INSERT INTO events (project_id,source,event_type,title,severity,payload)
         VALUES ($1,'command-center','approval',$2,$3,$4::jsonb)`,
        [approval.project_id, `Approval ${status}: ${approval.action}`, status === "approved" ? "info" : "warning", JSON.stringify({ approval_id: id, status, affected_task_id: ["record_income", "create_sales_lead", "send_email", "update_support_case"].includes(approval.action_type ?? "") ? null : affectedEntityId, financial_transaction_id: approval.action_type === "record_income" ? affectedEntityId : null, sales_lead_id: approval.action_type === "create_sales_lead" ? affectedEntityId : null, support_case_id: approval.action_type === "update_support_case" ? affectedEntityId : null, outbound_message_id: approval.action_type === "send_email" && status === "approved" ? affectedEntityId : null })],
      );
      return { affectedEntityId, actionType: approval.action_type };
    });

    if (!decision) return NextResponse.json({ error: "Pending approval not found." }, { status: 404 });
    if ("forbidden" in decision) return NextResponse.json({ error: "The agent is no longer permitted to request this action." }, { status: 403 });
    if ("unsupported" in decision) return NextResponse.json({ error: "No registered handler exists for this approval action." }, { status: 409 });
    return NextResponse.json({ ok: true, id, status, ...(decision.actionType === "record_income" ? { financial_transaction_id: decision.affectedEntityId } : decision.actionType === "create_sales_lead" ? { sales_lead_id: decision.affectedEntityId } : decision.actionType === "update_support_case" ? { support_case_id: decision.affectedEntityId } : decision.actionType === "send_email" ? { outbound_message_id: decision.affectedEntityId, delivery_status: "queued" } : { affected_task_id: decision.affectedEntityId }) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
