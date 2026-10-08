import type { PoolClient } from "pg";

export const DEFAULT_HANDOFF_EXPIRY_HOURS = 48;

/** Reads AGENT_HANDOFF_EXPIRY_HOURS; invalid or out-of-range values fall back to the default (1 hour to 30 days). */
export function handoffExpiryHours(raw: string | undefined): number {
  const hours = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(hours) || hours < 1 || hours > 720) return DEFAULT_HANDOFF_EXPIRY_HOURS;
  return hours;
}

/**
 * Marks manual handoffs that never received a pasted response as expired.
 * Only `awaiting_external` runs are touched, so the paste-back endpoint (which requires that status) rejects late responses
 * and the owner starts a fresh run instead of completing a stale prompt.
 */
export async function expireStaleHandoffs(client: Pick<PoolClient, "query">, hours: number): Promise<number> {
  const result = await client.query(
    `WITH expired AS (
       UPDATE agent_runs
       SET status='expired', summary='Manual handoff expired.', error=$2, completed_at=NOW()
       WHERE status='awaiting_external' AND created_at < NOW() - make_interval(hours => $1::int)
       RETURNING id, task_id, provider
     )
     INSERT INTO events (source,event_type,title,severity,payload)
     SELECT 'agent-router','agent_run_expired','Manual handoff expired','info',
            jsonb_build_object('run_id',id,'task_id',task_id,'provider',provider,'expiry_hours',$1::int)
     FROM expired`,
    [hours, `No response was pasted within ${hours} hours. Start a new run to try again.`],
  );
  return result.rowCount ?? 0;
}
