// Adapter for companyos-rag-service (FastAPI + pgvector + Ollama), the
// knowledge service that answers questions from indexed CompanyOS content.
// Server-side only: the service token must never reach the browser, and it
// is never logged.
//
// Asks run as background jobs on the service: starting a job returns
// immediately and the caller polls for the result. No request is ever held
// open for a whole CPU generation — a held-open request used to lose
// answers behind proxies with a response-wait limit.

export interface RagCitation {
  source: string;
  external_id: string;
  title: string;
  project_id: string | null;
  chunk_index: number;
  content: string;
  score: number;
}

export interface RagAnswer {
  answer: string;
  citations: RagCitation[];
}

export type RagJobStatus =
  | { status: "queued" | "running" }
  | { status: "done"; answer: RagAnswer }
  | { status: "error"; error: string };

// Job start and poll requests are short; bound each one well under any
// proxy's response-wait limit.
const JOB_REQUEST_TIMEOUT_MS = 30_000;

export function ragConfigured(): boolean {
  return Boolean(process.env.RAG_API_URL?.trim() && process.env.RAG_SERVICE_TOKEN?.trim());
}

function ragBaseAndToken(): { base: string; token: string } {
  const base = (process.env.RAG_API_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.RAG_SERVICE_TOKEN ?? "").trim();
  if (!base || !token) throw new Error("RAG service is not configured.");
  return { base, token };
}

export async function startRagAskJob(question: string): Promise<string> {
  const { base, token } = ragBaseAndToken();

  const response = await fetch(`${base}/ask/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question }),
    cache: "no-store",
    signal: AbortSignal.timeout(JOB_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`RAG service answered ${response.status}.`);

  const data = (await response.json()) as { job_id?: unknown };
  if (typeof data.job_id !== "string" || !data.job_id) {
    throw new Error("RAG service did not return a job id.");
  }
  return data.job_id;
}

export async function getRagAskJob(jobId: string): Promise<RagJobStatus> {
  const { base, token } = ragBaseAndToken();

  const response = await fetch(`${base}/ask/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(JOB_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return { status: "error", error: "That question expired before it finished — ask again." };
  }
  if (!response.ok) throw new Error(`RAG service answered ${response.status}.`);

  const data = (await response.json()) as {
    status?: unknown;
    answer?: unknown;
    citations?: unknown;
  };
  if (data.status === "done") {
    return {
      status: "done",
      answer: {
        answer: typeof data.answer === "string" ? data.answer : "",
        citations: Array.isArray(data.citations) ? (data.citations as RagCitation[]) : [],
      },
    };
  }
  if (data.status === "error") {
    return { status: "error", error: "The knowledge service could not answer that question." };
  }
  return { status: data.status === "running" ? "running" : "queued" };
}
