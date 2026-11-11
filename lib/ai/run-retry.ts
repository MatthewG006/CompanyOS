import type { PoolClient } from "pg";
import { createFailedRunRetry } from "./failed-run-retry.ts";

/**
 * Automatic retry + escalation policy for failed agent runs.
 *
 * The owner's rule: every task he sends or approves ends with a result or a
 * notification — never silent, endless retrying. So a failed run is either
 * retried a bounded number of times (transient failures only) or escalated
 * to exactly one open attention item on the Overview. Nothing in between:
 * no unbounded loops, no failures that only surface if he goes looking.
 */

export const MAX_AUTOMATIC_RETRIES = 2;

/** Backoff before automatic retry attempt 1 and 2, in milliseconds. */
export const AUTOMATIC_RETRY_DELAYS_MS = [60_000, 300_000] as const;

/** Providers the queue can re-run on its own (mirrors manual-retry eligibility). */
const RETRYABLE_PROVIDERS = ["codex-cli", "ollama", "auto"];

export type FailureKind = "transient" | "permanent";

/**
 * Permanent failures: retrying runs into the same wall. Checked first,
 * because several permanent strings ("not installed", the output limit)
 * contain words that also appear in transient ones.
 *
 * The 300 KB output limit is permanent on purpose: a task whose response
 * overflowed once is overwhelmingly likely to overflow again, so it
 * escalates immediately instead of burning another execution cycle.
 */
const PERMANENT_PATTERNS: RegExp[] = [
  /queued task is missing, complete, or unassigned/i,
  /no automatic provider satisfies/i,
  /no automatic ai provider is available/i,
  /is not installed or CODEX_CLI_PATH is invalid/i,
  /requires (OPENAI_API_KEY|ANTHROPIC_API_KEY|OLLAMA_MODEL|AI_OPENAI_MODEL|AI_ANTHROPIC_MODEL)/i,
  /exceeded the 300 KB limit/i,
  /output exceeded limit/i,
  /requires a manual handoff/i,
  /unsupported ai provider/i,
  /returned HTTP 4\d\d/i,
];

/**
 * Transient failures: infrastructure hiccups a later attempt plausibly
 * survives — execution timeouts, a worker that died mid-run (lease
 * expiry), a CLI that failed to start or crashed, an empty completion,
 * a provider 5xx, or a dropped connection.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /worker lease expired/i,
  /timed out/i,
  /could not start codex cli/i,
  /failed to start codex cli/i,
  /exited with (code|status)/i,
  /completed without a (final )?text response/i,
  /returned no text response/i,
  /returned HTTP 5\d\d/i,
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i,
];

/**
 * Classifies a failed run from its recorded error/summary. Unknown
 * failures default to permanent: an unrecognized error notifies the
 * owner sooner rather than spending retries on a guess.
 */
export function classifyFailure(error: string | null | undefined, summary?: string | null): FailureKind {
  const text = `${error ?? ""} ${summary ?? ""}`;
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) return "permanent";
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) return "transient";
  return "permanent";
}

/**
 * Automatic retries already spent on this run's lineage. The count travels
 * in each retry run's input (retry_context.automatic_attempt, set by
 * createFailedRunRetry), so the original run and owner-created manual
 * retries both count as 0.
 */
export function automaticAttemptOf(input: unknown): number {
  if (!input || typeof input !== "object" || Array.isArray(input)) return 0;
  const context = (input as { retry_context?: unknown }).retry_context;
  if (!context || typeof context !== "object" || Array.isArray(context)) return 0;
  const attempt = (context as { automatic_attempt?: unknown }).automatic_attempt;
  return typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
}

export type RetryDecision =
  | { action: "retry"; delayMs: number; nextAttempt: number }
  | { action: "escalate" };

export function retryDecision(attemptsUsed: number, kind: FailureKind): RetryDecision {
  if (kind === "transient" && attemptsUsed < MAX_AUTOMATIC_RETRIES) {
    return { action: "retry", delayMs: AUTOMATIC_RETRY_DELAYS_MS[attemptsUsed], nextAttempt: attemptsUsed + 1 };
  }
  return { action: "escalate" };
}

export type RunFailureOutcome =
  | { action: "retry"; retry_run_id: string; attempt: number }
  | { action: "escalated"; attention_item_id: string | null }
  | { action: "none"; reason: string };

type FailedRunRow = {
  id: string;
  task_id: string | null;
  provider: string;
  status: string;
  error: string | null;
  summary: string | null;
  input: Record<string, unknown> | null;
  task_title: string | null;
  project_id: string | null;
  agent_name: string | null;
};

/**
 * Finalizes a run that has just been marked failed (call inside the same
 * transaction that set the failure): applies the retry/escalation policy
 * exactly once for that run. Retries reuse the same linked-run creation as
 * the owner's manual retry, so the two paths dedupe against each other.
 * Escalation inserts one open attention item per task failure (deduped on
 * the item title + project while one is still open) and records an
 * agent_run_escalated event.
 */
export async function handleFailedRun(client: Pick<PoolClient, "query">, runId: string): Promise<RunFailureOutcome> {
  const result = await client.query<FailedRunRow>(
    `SELECT r.id,r.task_id,r.provider,r.status,r.error,r.summary,r.input,
       t.title AS task_title,t.project_id,a.name AS agent_name
     FROM agent_runs r
     LEFT JOIN tasks t ON t.id=r.task_id
     LEFT JOIN agents a ON a.id=r.agent_id
     WHERE r.id=$1`,
    [runId],
  );
  const run = result.rows[0];
  if (!run) return { action: "none", reason: "Agent run not found." };
  if (run.status !== "failed") return { action: "none", reason: "Agent run is not failed." };
  if (!RETRYABLE_PROVIDERS.includes(run.provider)) return { action: "none", reason: "Provider is not retryable." };

  const attemptsUsed = automaticAttemptOf(run.input);
  const decision = retryDecision(attemptsUsed, classifyFailure(run.error, run.summary));

  if (decision.action === "retry") {
    const retry = await createFailedRunRetry(client, run.id, {
      automaticAttempt: decision.nextAttempt,
      availableInMs: decision.delayMs,
      summary: `Queued automatic retry (attempt ${decision.nextAttempt} of ${MAX_AUTOMATIC_RETRIES}) after failed agent run.`,
      eventTitle: "Failed agent run queued for automatic retry",
    });
    if (retry.ok) return { action: "retry", retry_run_id: retry.run_id, attempt: decision.nextAttempt };
    // Refused (the task finished meanwhile, or a retry already exists):
    // the outcome is already owned by that completion or retry, so there
    // is nothing left to escalate.
    return { action: "none", reason: retry.error };
  }

  const agentName = run.agent_name ?? "An agent";
  const taskTitle = run.task_title ?? "Untitled task";
  const title = `Failed run — ${agentName} · ${taskTitle}`.slice(0, 200);
  const reason = (run.error ?? run.summary ?? "Unknown error.").slice(0, 400);
  const attemptsNote = attemptsUsed > 0 ? ` after ${attemptsUsed} automatic ${attemptsUsed === 1 ? "retry" : "retries"}` : "";
  const description = `${agentName}'s run for "${taskTitle}" failed${attemptsNote}: ${reason}`.slice(0, 1000);

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM attention_items
     WHERE source='agent-router' AND attention_type='agent_run_failed' AND status='open'
       AND title=$1 AND project_id IS NOT DISTINCT FROM $2::uuid
     LIMIT 1`,
    [title, run.project_id],
  );
  let attentionItemId = existing.rows[0]?.id ?? null;
  if (!attentionItemId) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO attention_items (source,attention_type,priority,title,description,status,project_id,updated_at)
       VALUES ('agent-router','agent_run_failed','high',$1,$2,'open',$3,NOW())
       RETURNING id`,
      [title, description, run.project_id],
    );
    attentionItemId = inserted.rows[0]?.id ?? null;
  }
  await client.query(
    `INSERT INTO events (source,event_type,title,severity,payload)
     VALUES ('agent-router','agent_run_escalated',$1,'warning',$2::jsonb)`,
    [
      `Agent run escalated to owner attention: ${taskTitle}`,
      JSON.stringify({ run_id: run.id, task_id: run.task_id, attention_item_id: attentionItemId, automatic_retries: attemptsUsed, error: reason }),
    ],
  );
  return { action: "escalated", attention_item_id: attentionItemId };
}
