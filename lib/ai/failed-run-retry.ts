import type { PoolClient } from "pg";

export type RetryOutcome =
  | { ok: true; run_id: string; status: string; already_retried: boolean }
  | { ok: false; error: string; statusCode: number };

export type QueueRetryOptions = {
  /**
   * Set by the automatic retry policy (lib/ai/run-retry.ts): marks the new
   * run's retry_context so the chain can count automatic attempts, and
   * holds the run back until the backoff delay has elapsed.
   */
  automaticAttempt?: number;
  availableInMs?: number;
  summary?: string;
  eventTitle?: string;
};

/**
 * Creates the single retry run linked to a failed run (agent_runs.retry_of_run_id,
 * unique per source run). Shared by the owner's manual retry in AgentConsole
 * (POST /api/agent-runs) and the automatic retry policy, so both paths dedupe
 * against each other: a run never has more than one retry child.
 *
 * Must be called with a client inside a transaction; the manual route
 * (app/api/agent-runs) wraps it in one. The module deliberately takes a
 * client instead of importing lib/db so the unit tests can load it
 * directly, like lib/ai/handoff-expiry.ts.
 */
export async function createFailedRunRetry(
  client: Pick<PoolClient, "query">,
  runId: string,
  options: QueueRetryOptions = {},
): Promise<RetryOutcome> {
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
  if (source.provider !== "codex-cli" && source.provider !== "ollama" && source.provider !== "auto") return { ok: false, error: "Only failed automated runs (Codex CLI, Ollama, auto) can be retried in the queue.", statusCode: 400 };
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
      ...(options.automaticAttempt
        ? { automatic: true, automatic_attempt: options.automaticAttempt }
        : {}),
    },
  };
  const availableAt = options.availableInMs ? new Date(Date.now() + options.availableInMs) : null;
  const inserted = await client.query<{ id: string; status: string }>(
    `INSERT INTO agent_runs (agent_id,task_id,provider,status,summary,input,retry_of_run_id,available_at)
     VALUES ($1,$2,$5,'queued',$6,$3::jsonb,$4,$7)
     ON CONFLICT (retry_of_run_id) WHERE retry_of_run_id IS NOT NULL DO NOTHING
     RETURNING id,status`,
    [source.agent_id, source.task_id, JSON.stringify(retryInput), source.id, source.provider, options.summary ?? "Queued retry after failed agent run.", availableAt],
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
     VALUES ('agent-router','agent_run_retried',$2,'info',$1::jsonb)`,
    [
      JSON.stringify({ previous_run_id: source.id, retry_run_id: retry.id, task_id: source.task_id, ...(options.automaticAttempt ? { automatic_attempt: options.automaticAttempt } : {}) }),
      options.eventTitle ?? "Failed agent run queued for retry",
    ],
  );
  await client.query("UPDATE workflow_dispatches SET agent_run_id=$2,status='queued' WHERE agent_run_id=$1", [source.id, retry.id]);
  return { ok: true, run_id: retry.id, status: retry.status, already_retried: false };
}
