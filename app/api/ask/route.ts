import { NextResponse } from "next/server";
import { getRagAskJob, ragConfigured, startRagAskJob } from "@/lib/integrations/rag";

export const dynamic = "force-dynamic";
// Asks run as background jobs on the knowledge service, so every request
// here is short: POST starts a job, GET polls it. No request waits on a
// CPU generation, so a modest duration cap is plenty.
export const maxDuration = 60;

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

function denied() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

function notConfigured() {
  return NextResponse.json(
    { error: "Ask CompanyOS is not configured yet. Set RAG_API_URL and RAG_SERVICE_TOKEN." },
    { status: 503 },
  );
}

const UPSTREAM_ERROR = "The knowledge service did not answer. It may be offline or busy — try again in a moment.";

export async function POST(request: Request) {
  if (!authorized(request)) return denied();

  let question = "";
  try {
    const body = await request.json();
    question = typeof body?.question === "string" ? body.question.trim() : "";
  } catch {
    return NextResponse.json({ error: "Enter a question." }, { status: 400 });
  }
  if (!question) return NextResponse.json({ error: "Enter a question." }, { status: 400 });
  if (question.length > 2000) {
    return NextResponse.json({ error: "Keep the question under 2,000 characters." }, { status: 400 });
  }

  if (!ragConfigured()) return notConfigured();

  try {
    const jobId = await startRagAskJob(question);
    return NextResponse.json({ jobId }, { status: 202 });
  } catch {
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return denied();

  const jobId = new URL(request.url).searchParams.get("jobId")?.trim() ?? "";
  if (!jobId) return NextResponse.json({ error: "Missing job id." }, { status: 400 });

  if (!ragConfigured()) return notConfigured();

  try {
    const job = await getRagAskJob(jobId);
    if (job.status === "done") {
      return NextResponse.json({ status: "done", answer: job.answer.answer, citations: job.answer.citations });
    }
    if (job.status === "error") {
      return NextResponse.json({ error: job.error }, { status: 502 });
    }
    return NextResponse.json({ status: "pending" });
  } catch {
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }
}
