import { NextResponse } from "next/server";
import { databaseAvailable, query, transaction } from "@/lib/db";
import { loadAgentMemory } from "@/lib/ai/memory";
import { recordAgentProposals } from "@/lib/ai/actions";
import { buildTaskPrompt, configuredProviders, getCodexCliStatus, handoffProviders, isAgentProvider, runWithCodexCli, runWithProvider, type AgentTask, type RoutedProvider } from "@/lib/ai/router";

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
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  const runs = await query(`SELECT r.id,r.task_id,t.title AS task_title,r.provider,r.model,r.status,r.summary,r.input,r.result,r.error,r.created_at::text,r.started_at::text,r.completed_at::text,a.name AS agent_name,
      retry_run.id AS retry_run_id,retry_run.status AS retry_status
    FROM agent_runs r LEFT JOIN tasks t ON t.id=r.task_id LEFT JOIN agents a ON a.id=r.agent_id
    LEFT JOIN agent_runs retry_run ON retry_run.retry_of_run_id=r.id
    ORDER BY r.created_at DESC LIMIT 25`);
  const countResult = await query<{ status: string; count: string }>("SELECT status,COUNT(*)::text AS count FROM agent_runs GROUP BY status");
  const run_counts = Object.fromEntries(countResult.rows.map((row) => [row.status, Number(row.count)]));
  const codex_cli = await getCodexCliStatus();
  const workerResult = await query<{ status: string; details: { codex_cli_authenticated?: boolean }; last_seen_at: string; online: boolean }>(
    `SELECT status,details,last_seen_at::text,(last_seen_at > NOW()-INTERVAL '3 minutes') AS online
     FROM runtime_heartbeats WHERE service_name='agent-worker'`,
  );
  return NextResponse.json({ runs: runs.rows, run_counts, providers: { ...configuredProviders(), "codex-cli": codex_cli.authenticated }, provider_status: { "codex-cli": codex_cli }, agent_worker: workerResult.rows[0] ?? null, auth_required: process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN) });
}

type RetryOutcome =
  | { ok: true; run_id: string; status: string; already_retried: boolean }
  | { ok: false; error: string; statusCode: number };

async function queueFailedCodexRetry(runId: string): Promise<RetryOutcome> {
  return transaction(async (client) => {
    const sourceResult = await client.query<{
      id: string;
      task_id: string | null;
      agent_id: string | null;
      provider: string;
      status: string;
      summary: string | null;
      error: string | null;
      input: Record<string, unknown> | null;
      task_status: string | null;
    }>(`SELECT r.id,r.task_id,r.agent_id,r.provider,r.status,r.summary,r.error,r.input,t.status AS task_status
      FROM agent_runs r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 FOR UPDATE OF r`, [runId]);
    const source = sourceResult.rows[0];
    if (!source) return { ok: false, error: "Agent run not found.", statusCode: 404 };
    if (source.provider !== "codex-cli") return { ok: false, error: "Only failed Codex CLI runs can be retried in the queue.", statusCode: 400 };
    if (source.status !== "failed") return { ok: false, error: "Only failed runs can be retried.", statusCode: 409 };
    if (!source.task_id || !source.agent_id || !source.task_status || source.task_status === "done") {
      return { ok: false, error: "The failed run's task is missing, complete, or unassigned.", statusCode: 409 };
    }

    const priorRetry = await client.query<{ id: string; status: string }>(
      "SELECT id,status FROM agent_runs WHERE retry_of_run_id=$1 LIMIT 1",
      [source.id],
    );
    if (priorRetry.rows[0]) {
      return { ok: true, run_id: priorRetry.rows[0].id, status: priorRetry.rows[0].status, already_retried: true };
    }

    const originalInput = source.input && typeof source.input === "object" && !Array.isArray(source.input)
      ? source.input
      : {};
    const retryInput = {
      source: "failed-run-retry",
      workflow_context: originalInput.workflow_context,
      retry_context: {
        previous_run_id: source.id,
        previous_error: source.error?.slice(0, 400) ?? null,
        previous_summary: source.summary?.slice(0, 400) ?? null,
      },
    };
    const inserted = await client.query<{ id: string; status: string }>(
      `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,input,retry_of_run_id)
       VALUES ($1,$2,'codex-cli','queued','Queued retry after failed Codex CLI run.',$3::jsonb,$4)
       ON CONFLICT (retry_of_run_id) WHERE retry_of_run_id IS NOT NULL DO NOTHING
       RETURNING id,status`,
      [source.agent_id, source.task_id, JSON.stringify(retryInput), source.id],
    );
    const retry = inserted.rows[0];
    if (!retry) {
      const concurrentRetry = await client.query<{ id: string; status: string }>(
        "SELECT id,status FROM agent_runs WHERE retry_of_run_id=$1 LIMIT 1",
        [source.id],
      );
      const existing = concurrentRetry.rows[0];
      if (!existing) throw new Error("Could not save the retry run.");
      return { ok: true, run_id: existing.id, status: existing.status, already_retried: true };
    }

    await client.query(
      `INSERT INTO events (source,event_type,title,severity,payload)
       VALUES ('agent-router','agent_run_retried','Failed Codex run queued for retry','info',$1::jsonb)`,
      [JSON.stringify({ previous_run_id: source.id, retry_run_id: retry.id, task_id: source.task_id })],
    );
    await client.query("UPDATE workflow_dispatches SET agent_run_id=$2,status='queued' WHERE agent_run_id=$1", [source.id, retry.id]);
    return { ok: true, run_id: retry.id, status: retry.status, already_retried: false };
  });
}

export async function POST(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    if (typeof body?.retry_run_id === "string") {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.retry_run_id)) {
        return NextResponse.json({ error: "A valid retry_run_id is required." }, { status: 400 });
      }
      const retry = await queueFailedCodexRetry(body.retry_run_id);
      if (!retry.ok) return NextResponse.json({ error: retry.error }, { status: retry.statusCode });
      return NextResponse.json({ ok: true, run_id: retry.run_id, status: retry.status, already_retried: retry.already_retried });
    }
    const taskId = typeof body?.task_id === "string" ? body.task_id : "";
    const provider = body?.provider;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
      return NextResponse.json({ error: "A valid task_id is required." }, { status: 400 });
    }
    if (!isAgentProvider(provider)) return NextResponse.json({ error: "Choose a supported provider." }, { status: 400 });
    if (provider === "codex-cli") {
      const codex = await getCodexCliStatus();
      if (!codex.authenticated) return NextResponse.json({ error: codex.message, provider_status: codex }, { status: 503 });
    }
    const taskResult = await query<AgentTask & { id: string; project_id: string | null; agent_id: string | null; status: string }>(`SELECT t.id,t.title,t.priority,t.status,t.project_id,p.name AS project_name,a.id AS agent_id,a.name AS agent_name,a.role AS agent_role,a.mission AS agent_mission,a.description AS agent_description,a.memory_scope AS agent_memory_scope,a.allowed_actions AS agent_allowed_actions,manager.name AS agent_manager_name,
        COALESCE((SELECT json_agg(json_build_object('id',child.id,'name',child.name,'role',child.role)) FROM agents child WHERE child.reports_to=a.id),'[]'::json) AS agent_direct_reports
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN agents a ON a.id=t.agent_id
      LEFT JOIN agents manager ON manager.id=a.reports_to WHERE t.id=$1`, [taskId]);
    const task = taskResult.rows[0];
    if (!task || task.status === "done") return NextResponse.json({ error: "Open task not found." }, { status: 404 });

    const memory = await loadAgentMemory(task.project_id, task.agent_memory_scope, task.id);
    const prompt = buildTaskPrompt(task, memory);
    const manual = (handoffProviders as readonly string[]).includes(provider);
    const input = { prompt, task: { title: task.title, project: task.project_name, priority: task.priority }, memory };
    const inserted = await query<{ id: string }>(`INSERT INTO agent_runs (agent_id,task_id,provider,model,status,summary,input,started_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,CASE WHEN $5='running' THEN NOW() ELSE NULL END) RETURNING id`, [
      task.agent_id, task.id, provider, manual ? "manual handoff" : null, manual ? "awaiting_external" : "running", manual ? "Prompt ready for manual provider handoff." : "Model task started.", JSON.stringify(input),
    ]);
    const runId = inserted.rows[0].id;

    if (manual) {
      await query("INSERT INTO events (source,event_type,title,severity,payload) VALUES ('agent-router','agent_run_queued',$1,'info',$2::jsonb)", [`Task handed off to ${provider}`, JSON.stringify({ run_id: runId, task_id: task.id })]);
      return NextResponse.json({ ok: true, run_id: runId, status: "awaiting_external", prompt, provider });
    }

    try {
      const result = provider === "codex-cli"
        ? await runWithCodexCli(prompt)
        : await runWithProvider(provider as RoutedProvider, prompt);
      const proposalCount = await transaction(async (client) => {
        await client.query("UPDATE agent_runs SET model=$2,status='completed',summary=$3,result=$4::jsonb,completed_at=NOW() WHERE id=$1", [runId, result.model, result.text.slice(0, 500), JSON.stringify({ text: result.text })]);
        const count = await recordAgentProposals(client, runId, result.text);
        await client.query("INSERT INTO events (source,event_type,title,severity,payload) VALUES ('agent-router','agent_run_completed',$1,'info',$2::jsonb)", [`Task run completed: ${task.title}`, JSON.stringify({ run_id: runId, task_id: task.id, provider, approval_proposals: count })]);
        return count;
      });
      return NextResponse.json({ ok: true, run_id: runId, status: "completed", model: result.model, result: result.text, approval_proposals: proposalCount });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 400) : "Model execution failed.";
      await query("UPDATE agent_runs SET status='failed',error=$2,summary='Model execution failed.',completed_at=NOW() WHERE id=$1", [runId, detail]);
      await query("INSERT INTO events (source,event_type,title,severity,payload) VALUES ('agent-router','agent_run_failed',$1,'warning',$2::jsonb)", [`Task run failed: ${task.title}`, JSON.stringify({ run_id: runId, task_id: task.id, provider, error: detail })]);
      return NextResponse.json({ error: detail, run_id: runId, status: "failed" }, { status: 502 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid agent-run request." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  try {
    const body = await request.json();
    const id = typeof body?.run_id === "string" ? body.run_id : "";
    const output = typeof body?.output === "string" ? body.output.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !output || output.length > 30_000) {
      return NextResponse.json({ error: "A valid run_id and an output between 1 and 30000 characters are required." }, { status: 400 });
    }
    const completion = await transaction(async (client) => {
      const result = await client.query<{ id: string; task_id: string | null; provider: string }>(`UPDATE agent_runs SET status='completed',result=$2::jsonb,summary=$3,completed_at=NOW()
        WHERE id=$1 AND status='awaiting_external' AND provider=ANY($4::text[]) RETURNING id,task_id,provider`, [id, JSON.stringify({ text: output }), output.slice(0, 500), handoffProviders]);
      if (!result.rowCount) return null;
      const run = result.rows[0];
      const proposalCount = await recordAgentProposals(client, id, output);
      await client.query("INSERT INTO events (source,event_type,title,severity,payload) VALUES ('agent-router','agent_run_completed',$1,'info',$2::jsonb)", [`Manual task result received from ${run.provider}`, JSON.stringify({ run_id: id, task_id: run.task_id, provider: run.provider, approval_proposals: proposalCount })]);
      return proposalCount;
    });
    if (completion === null) return NextResponse.json({ error: "Manual handoff run not found or already completed." }, { status: 404 });
    return NextResponse.json({ ok: true, run_id: id, status: "completed", approval_proposals: completion });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid manual result." }, { status: 400 });
  }
}
