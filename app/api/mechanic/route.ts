import { NextResponse } from "next/server";
import { transaction } from "@/lib/db";
import {
  createMechanicRepairApproval,
  gatherWorkerHealthEvidence,
  getMechanicDiagnosisJob,
  mechanicConfigured,
  startMechanicDiagnosisJob,
} from "@/lib/integrations/mechanic";

export const dynamic = "force-dynamic";
// Diagnoses run as background jobs on the mechanic service (the RAG
// host's LLM), so every request here is short: POST gathers evidence and
// starts a job, GET polls it — and, on completion, records any
// recommended repair as an owner approval exactly once.
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
    { error: "The mechanic is not configured yet. Set RAG_API_URL and RAG_SERVICE_TOKEN." },
    { status: 503 },
  );
}

const UPSTREAM_ERROR = "The mechanic service did not answer. It may be offline or busy — try again in a moment.";

export async function POST(request: Request) {
  if (!authorized(request)) return denied();
  if (!mechanicConfigured()) return notConfigured();

  try {
    const evidence = await gatherWorkerHealthEvidence();
    const jobId = await startMechanicDiagnosisJob(evidence);
    return NextResponse.json({ jobId }, { status: 202 });
  } catch {
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return denied();

  const jobId = new URL(request.url).searchParams.get("jobId")?.trim() ?? "";
  if (!jobId) return NextResponse.json({ error: "Missing job id." }, { status: 400 });

  if (!mechanicConfigured()) return notConfigured();

  try {
    const job = await getMechanicDiagnosisJob(jobId);
    if (job.status === "done") {
      const approvalId = await transaction(async (client) =>
        createMechanicRepairApproval(client, jobId, job.diagnosis),
      );
      return NextResponse.json({ status: "done", diagnosis: job.diagnosis, approvalId });
    }
    if (job.status === "error") {
      return NextResponse.json({ error: job.error }, { status: 502 });
    }
    return NextResponse.json({ status: "pending" });
  } catch {
    return NextResponse.json({ error: UPSTREAM_ERROR }, { status: 502 });
  }
}
