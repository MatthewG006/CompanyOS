export const DEFAULT_LOCAL_RUNS_PER_HOUR = 30;

/** Reads AGENT_LOCAL_MAX_RUNS_PER_HOUR. 0 means no limit; invalid or out-of-range values use the default. */
export function localRunsPerHour(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LOCAL_RUNS_PER_HOUR;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) return DEFAULT_LOCAL_RUNS_PER_HOUR;
  return limit;
}

export type LocalCapStatus = { limit: number; used: number; capped: boolean };

export function evaluateLocalCap(used: number, limit: number): LocalCapStatus {
  return { limit, used, capped: limit > 0 && used >= limit };
}

/** Human-readable explanation to append to errors when the cap, not availability, removed the local model. */
export function capNotice(status: LocalCapStatus): string {
  return status.capped
    ? ` Local model limit reached (${status.used} of ${status.limit} runs in the last hour); raise AGENT_LOCAL_MAX_RUNS_PER_HOUR or wait.`
    : "";
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ count: string }> }>;

/**
 * Counts Ollama runs started in the last hour. Queued worker runs only record `ollama` once they finish
 * (they are claimed as `codex-cli`), so with several workers the cap can be exceeded briefly by in-flight runs.
 * Failed runs count because the model still did the work.
 */
export async function localCapStatus(run: QueryFn, limit: number): Promise<LocalCapStatus> {
  if (limit === 0) return evaluateLocalCap(0, 0);
  const result = await run(
    `SELECT COUNT(*)::text AS count FROM agent_runs
     WHERE provider='ollama' AND status IN ('running','completed','failed')
       AND COALESCE(started_at, created_at) > NOW() - INTERVAL '1 hour'`,
  );
  return evaluateLocalCap(Number(result.rows[0]?.count ?? 0), limit);
}
