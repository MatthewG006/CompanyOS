import { NextResponse } from "next/server";
import { askRagService, ragConfigured } from "@/lib/integrations/rag";

export const dynamic = "force-dynamic";
// The knowledge service generates answers with a local LLM on CPU; allow
// the route to wait for it instead of cutting the answer off.
export const maxDuration = 300;

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

function denied() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

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

  if (!ragConfigured()) {
    return NextResponse.json(
      { error: "Ask CompanyOS is not configured yet. Set RAG_API_URL and RAG_SERVICE_TOKEN." },
      { status: 503 },
    );
  }

  try {
    const result = await askRagService(question);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "The knowledge service did not answer. It may be offline or busy — try again in a moment." },
      { status: 502 },
    );
  }
}
