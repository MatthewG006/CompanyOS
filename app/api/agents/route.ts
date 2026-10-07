import { NextResponse } from "next/server";
import { databaseAvailable, transaction } from "@/lib/db";

export const dynamic = "force-dynamic";

const actions = new Set(["request_task_creation", "request_task_status_change", "request_task_delegation", "request_financial_entry", "request_sales_lead", "request_email_outreach", "request_support_case_update"]);
const scopes = new Set(["project", "tasks", "systems", "sales", "support"]);

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`
    || request.headers.get("x-companyos-admin-token") === expected;
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });

  try {
    const body = await request.json();
    const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) {
      return NextResponse.json({ error: "A valid agent_id is required." }, { status: 400 });
    }
    if (!Array.isArray(body?.allowed_actions) || !Array.isArray(body?.memory_scope)
      || body.allowed_actions.some((value: unknown) => typeof value !== "string" || !actions.has(value))
      || body.memory_scope.some((value: unknown) => typeof value !== "string" || !scopes.has(value))) {
      return NextResponse.json({ error: "Choose only the supported action permissions and memory scopes." }, { status: 400 });
    }

    const allowedActions = [...new Set(body.allowed_actions as string[])];
    const memoryScope = [...new Set(body.memory_scope as string[])];
    const updated = await transaction(async (client) => {
      const agentResult = await client.query<{ id: string; name: string; has_direct_reports: boolean }>(
        `SELECT a.id,a.name,EXISTS(SELECT 1 FROM agents child WHERE child.reports_to=a.id) AS has_direct_reports
         FROM agents a WHERE a.id=$1 FOR UPDATE OF a`,
        [agentId],
      );
      const agent = agentResult.rows[0];
      if (!agent) return { status: 404 as const, error: "Agent not found." };
      if (allowedActions.includes("request_task_delegation") && !agent.has_direct_reports) {
        return { status: 400 as const, error: "Delegation permission is available only to agents with direct reports." };
      }
      if (allowedActions.includes("request_financial_entry") && agent.name.toLowerCase() !== "finance") {
        return { status: 400 as const, error: "Financial-entry proposals are available only to the Finance agent." };
      }
      if (allowedActions.includes("request_sales_lead") && agent.name.toLowerCase() !== "sales") {
        return { status: 400 as const, error: "Lead proposals are available only to the Sales agent." };
      }
      if (allowedActions.includes("request_email_outreach") && (agent.name.toLowerCase() !== "sales" || !memoryScope.includes("sales"))) {
        return { status: 400 as const, error: "Email outreach requires the Sales agent and the explicitly enabled sales memory scope." };
      }
      if (memoryScope.includes("sales") && agent.name.toLowerCase() !== "sales") {
        return { status: 400 as const, error: "Sales contact memory is restricted to the Sales agent." };
      }
      if (allowedActions.includes("request_support_case_update") && (agent.name.toLowerCase() !== "support" || !memoryScope.includes("support"))) {
        return { status: 400 as const, error: "Support case updates require the Support agent and the explicitly enabled support memory scope." };
      }
      if (memoryScope.includes("support") && agent.name.toLowerCase() !== "support") {
        return { status: 400 as const, error: "Support case memory is restricted to the Support agent." };
      }

      await client.query("UPDATE agents SET allowed_actions=$2::jsonb,memory_scope=$3::jsonb WHERE id=$1", [
        agent.id,
        JSON.stringify(allowedActions),
        JSON.stringify(memoryScope),
      ]);
      await client.query(
        `INSERT INTO events (source,event_type,title,severity,payload)
         VALUES ('owner-policy','agent_policy_updated',$1,'info',$2::jsonb)`,
        [`Agent policy updated: ${agent.name}`, JSON.stringify({ agent_id: agent.id, allowed_actions: allowedActions, memory_scope: memoryScope })],
      );
      return { status: 200 as const, agent_name: agent.name, allowed_actions: allowedActions, memory_scope: memoryScope };
    });

    if (updated.status !== 200) return NextResponse.json({ error: updated.error }, { status: updated.status });
    return NextResponse.json({ ok: true, ...updated, auth_required: process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save agent policy." }, { status: 400 });
  }
}
