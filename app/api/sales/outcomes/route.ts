import { NextResponse } from "next/server";
import { apiErrorFrom, databaseUnavailable } from "@/lib/api-errors";
import { databaseAvailable, query, transaction } from "@/lib/db";
import { startOnboardingForWonLead } from "@/lib/sales/onboarding";

export const dynamic = "force-dynamic";

const OUTCOMES = new Set(["contacted", "visit", "quote", "won", "lost"]);
const STAGE_ORDER: Record<string, number> = { new: 0, qualified: 1, proposal: 2, won: 3, lost: 3 };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`
    || request.headers.get("x-companyos-admin-token") === expected;
}

function denied() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

/**
 * The stage an outcome advances a lead to, or null to leave the stage as
 * is. Outcomes only move a lead forward: a quote never pulls a won lead
 * back to proposal, and lost/won are reachable from anywhere.
 */
function stageForOutcome(outcome: string, currentStage: string): string | null {
  if (outcome === "won") return currentStage === "won" ? null : "won";
  if (outcome === "lost") return currentStage === "lost" ? null : "lost";
  if (currentStage === "won" || currentStage === "lost") return null;
  if (outcome === "contacted") return currentStage === "new" ? "qualified" : null;
  if (outcome === "quote") return STAGE_ORDER[currentStage] < STAGE_ORDER.proposal ? "proposal" : null;
  return null; // visit: an activity, not a stage change
}

export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return databaseUnavailable();
  const result = await query(`SELECT o.id,o.lead_id,o.outcome,o.note,o.created_at::text,l.opportunity_title,p.name AS project_name
    FROM lead_outcomes o JOIN sales_leads l ON l.id=o.lead_id JOIN projects p ON p.id=l.project_id
    ORDER BY o.created_at DESC LIMIT 60`);
  return NextResponse.json({ outcomes: result.rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return databaseUnavailable();
  try {
    const body = await request.json();
    const leadId = typeof body?.lead_id === "string" ? body.lead_id : "";
    const outcome = typeof body?.outcome === "string" ? body.outcome : "";
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 1000) : "";
    if (!uuidPattern.test(leadId) || !OUTCOMES.has(outcome)) {
      return NextResponse.json({ error: "A valid lead and an outcome of contacted, visit, quote, won, or lost are required." }, { status: 400 });
    }

    const recorded = await transaction(async (client) => {
      const leadResult = await client.query<{ id: string; project_id: string; opportunity_title: string; stage: string; first_contacted_at: string | null }>(
        "SELECT id,project_id,opportunity_title,stage,first_contacted_at::text FROM sales_leads WHERE id=$1 FOR UPDATE", [leadId],
      );
      const lead = leadResult.rows[0];
      if (!lead) return null;
      await client.query("INSERT INTO lead_outcomes (lead_id,outcome,note) VALUES ($1,$2,$3)", [leadId, outcome, note]);
      const nextStage = stageForOutcome(outcome, lead.stage);
      // First contact is whichever happens first: a contacted/visit outcome,
      // or the stage advancing off "new" through this outcome.
      const firstContact = !lead.first_contacted_at && (outcome === "contacted" || outcome === "visit" || nextStage !== null) ? new Date() : null;
      if (nextStage || firstContact) {
        await client.query(
          `UPDATE sales_leads SET stage=COALESCE($2,stage),first_contacted_at=COALESCE(first_contacted_at,$3),updated_at=NOW() WHERE id=$1`,
          [leadId, nextStage, firstContact],
        );
      }
      if (nextStage === "won") {
        await startOnboardingForWonLead(client, { id: lead.id, project_id: lead.project_id, opportunity_title: lead.opportunity_title });
      }
      await client.query(`INSERT INTO events (source,event_type,title,severity,project_id,payload)
        VALUES ('sales-pipeline','lead_outcome_recorded',$1,'info',$2,$3::jsonb)`, [
        `Lead outcome ${outcome}: ${lead.opportunity_title}`,
        lead.project_id,
        JSON.stringify({ lead_id: leadId, outcome, stage_before: lead.stage, stage_after: nextStage ?? lead.stage }),
      ]);
      return { stage: nextStage ?? lead.stage };
    });
    if (!recorded) return NextResponse.json({ error: "Sales opportunity not found." }, { status: 404 });
    return NextResponse.json({ ok: true, lead_id: leadId, outcome, stage: recorded.stage });
  } catch (error) {
    return apiErrorFrom(error, "Could not record the outcome.", 400);
  }
}
