// Trust check for the agent-worker's self-reported Codex CLI status.
//
// The worker writes a single runtime_heartbeats row (primary key
// service_name) saying whether its Codex CLI is signed in. That row is
// self-reported, so the dispatch routes only trust it inside a short
// freshness window and only while the worker reports status "online":
// a heartbeat that has gone quiet, or one written by a degraded worker,
// must not green-light queueing Codex runs on the worker's host.

export const WORKER_CODEX_TRUST_WINDOW_SECONDS = 45;

export type WorkerHeartbeat = {
  status: string;
  details: { codex_cli_authenticated?: boolean } | null;
  age_seconds: number;
};

export function workerReportsCodexAvailable(worker: WorkerHeartbeat | null | undefined): boolean {
  if (!worker) return false;
  if (worker.status !== "online") return false;
  if (worker.details?.codex_cli_authenticated !== true) return false;
  return worker.age_seconds <= WORKER_CODEX_TRUST_WINDOW_SECONDS;
}
