import { NextResponse } from "next/server";
import { databaseAvailable, query, transaction } from "@/lib/db";
import { loadAgentMemory } from "@/lib/ai/memory";
import { recordAgentProposals } from "@/lib/ai/actions";
import { buildTaskPrompt, getCodexCliStatus, runWithCodexCli, type AgentTask } from "@/lib/ai/router";
import { dispatchDueSalesFollowups } from "@/lib/workflows/sales-followups";
import { processNextOutboundEmail } from "@/lib/workflows/outbound-email";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const outboundEmail = await processNextOutboundEmail();
    if (outboundEmail) return NextResponse.json({ worked: true, kind: "outbound_email", outbound_message_id: outboundEmail.id, status: outboundEmail.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Outbound email worker failed." }, { status: 500 });
  }
  const codex = await getCodexCliStatus();
  const workerInstanceId = request.headers.get("x-companyos-agent-worker-id");
  if (workerInstanceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workerInstanceId)) {
    await query(
      `INSERT INTO runtime_heartbeats (service_name,instance_id,status,details,last_seen_at)
       VALUES ('agent-worker',$1,$2,$3::jsonb,NOW())
       ON CONFLICT (service_name) DO UPDATE SET instance_id=EXCLUDED.instance_id,status=EXCLUDED.status,details=EXCLUDED.details,last_seen_at=NOW()`,
      [workerInstanceId, codex.authenticated ? "online" : "degraded", JSON.stringify({ codex_cli_authenticated: codex.authenticated })],
    );
  }
  let salesRemindersCreated = 0;
  try {
    salesRemindersCreated = await dispatchDueSalesFollowups();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sales reminder dispatch failed." }, { status: 500 });
  }
  if (!codex.authenticated) return NextResponse.json({ error: codex.message, provider_status: codex, sales_reminders_created: salesRemindersCreated }, { status: 503 });

  try {
    const run = await transaction(async (client) => {
      await client.query(`WITH expired AS (
          UPDATE agent_runs SET status='failed',error='Worker lease expired.',summary='Worker lease expired.',completed_at=NOW()
          WHERE status='running' AND provider='codex-cli' AND summary='Worker running.' AND started_at < NOW()-INTERVAL '5 minutes'
          RETURNING id
        )
        UPDATE workflow_dispatches SET status='failed' WHERE agent_run_id IN (SELECT id FROM expired)`);
      const result = await client.query<{ id: string; task_id: string | null; input: Record<string, unknown> }>(
        `WITH candidate AS (
           SELECT id FROM agent_runs WHERE status='queued' AND provider='codex-cli'
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE agent_runs r SET status='running',summary='Worker running.',started_at=NOW(),error=NULL
         FROM candidate c WHERE r.id=c.id RETURNING r.id,r.task_id,r.input`,
      );
      const claimed = result.rows[0] ?? null;
      if (claimed) await client.query("UPDATE workflow_dispatches SET status='running' WHERE agent_run_id=$1", [claimed.id]);
      return claimed;
    });
    if (!run) return NextResponse.json({ worked: false, status: "idle", sales_reminders_created: salesRemindersCreated });

    const taskResult = await query<AgentTask & { id: string; project_id: string | null; agent_id: string | null; status: string }>(
      `SELECT t.id,t.title,t.priority,t.status,t.project_id,p.name AS project_name,a.id AS agent_id,a.name AS agent_name,a.role AS agent_role,a.mission AS agent_mission,a.description AS agent_description,a.memory_scope AS agent_memory_scope,a.allowed_actions AS agent_allowed_actions,manager.name AS agent_manager_name,
         COALESCE((SELECT json_agg(json_build_object('id',child.id,'name',child.name,'role',child.role)) FROM agents child WHERE child.reports_to=a.id),'[]'::json) AS agent_direct_reports
       FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN agents a ON a.id=t.agent_id
       LEFT JOIN agents manager ON manager.id=a.reports_to WHERE t.id=$1`, [run.task_id],
    );
    const task = taskResult.rows[0];
    if (!task || task.status === "done" || task.agent_id === null) {
      await transaction(async (client) => {
        await client.query(`UPDATE agent_runs SET status='failed',error='Queued task is missing, complete, or unassigned.',summary='Delegated task could not start.',completed_at=NOW() WHERE id=$1 AND status='running'`, [run.id]);
        await client.query("UPDATE workflow_dispatches SET status='failed' WHERE agent_run_id=$1", [run.id]);
      });
      return NextResponse.json({ worked: true, run_id: run.id, status: "failed" });
    }

    const baseMemory = await loadAgentMemory(task.project_id, task.agent_memory_scope, task.id);
    const workflowContext = run.input?.workflow_context;
    const retryContext = run.input?.retry_context;
    const memory = {
      ...baseMemory,
      ...(workflowContext && typeof workflowContext === "object" ? { gmail_follow_up: workflowContext } : {}),
      ...(retryContext && typeof retryContext === "object" ? { retry_context: retryContext } : {}),
    };
    const prompt = buildTaskPrompt(task, memory);
    await query("UPDATE agent_runs SET input=input || $2::jsonb WHERE id=$1", [run.id, JSON.stringify({ prompt, task: { title: task.title, project: task.project_name, priority: task.priority }, memory })]);
    try {
      const result = await runWithCodexCli(prompt);
      const proposalCount = await transaction(async (client) => {
        const finished = await client.query("UPDATE agent_runs SET model=$2,status='completed',summary=$3,result=$4::jsonb,completed_at=NOW() WHERE id=$1 AND status='running'", [run.id, result.model, result.text.slice(0, 500), JSON.stringify({ text: result.text })]);
        if (!finished.rowCount) throw new Error("The delegated run is no longer active.");
        await client.query("UPDATE workflow_dispatches SET status='completed' WHERE agent_run_id=$1", [run.id]);
        const count = await recordAgentProposals(client, run.id, result.text);
        await client.query("INSERT INTO events (source,event_type,title,severity,payload) VALUES ('agent-router','agent_run_completed',$1,'info',$2::jsonb)", [`Delegated task run completed: ${task.title}`, JSON.stringify({ run_id: run.id, task_id: task.id, provider: "codex-cli", approval_proposals: count })]);
        return count;
      });
      return NextResponse.json({ worked: true, run_id: run.id, status: "completed", approval_proposals: proposalCount });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 400) : "Codex CLI execution failed.";
      await transaction(async (client) => {
        await client.query("UPDATE agent_runs SET status='failed',error=$2,summary='Delegated run failed.',completed_at=NOW() WHERE id=$1 AND status='running'", [run.id, detail]);
        await client.query("UPDATE workflow_dispatches SET status='failed' WHERE agent_run_id=$1", [run.id]);
        await client.query("INSERT INTO events (source,event_type,title,severity,payload) VALUES ('agent-router','agent_run_failed',$1,'warning',$2::jsonb)", [`Delegated task run failed: ${task.title}`, JSON.stringify({ run_id: run.id, task_id: task.id, error: detail })]);
      });
      return NextResponse.json({ worked: true, run_id: run.id, status: "failed" });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Agent worker failed." }, { status: 500 });
  }
}
