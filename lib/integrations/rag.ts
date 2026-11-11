// Adapter for companyos-rag-service (FastAPI + pgvector + Ollama), the
// knowledge service that answers questions from indexed CompanyOS content.
// Server-side only: the service token must never reach the browser, and it
// is never logged.

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

// The local LLM generates on CPU, so an answer can take a while. The wait
// is bounded well under the /api/ask route's maxDuration.
const ASK_TIMEOUT_MS = 240_000;

export function ragConfigured(): boolean {
  return Boolean(process.env.RAG_API_URL?.trim() && process.env.RAG_SERVICE_TOKEN?.trim());
}

export async function askRagService(question: string): Promise<RagAnswer> {
  const base = (process.env.RAG_API_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.RAG_SERVICE_TOKEN ?? "").trim();
  if (!base || !token) throw new Error("RAG service is not configured.");

  const response = await fetch(`${base}/ask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question }),
    cache: "no-store",
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`RAG service answered ${response.status}.`);

  const data = (await response.json()) as Partial<RagAnswer>;
  return {
    answer: typeof data.answer === "string" ? data.answer : "",
    citations: Array.isArray(data.citations) ? data.citations : [],
  };
}
