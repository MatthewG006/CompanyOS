import { NextResponse } from "next/server";
import { databaseAvailable, query, transaction } from "@/lib/db";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}` || request.headers.get("x-companyos-admin-token") === expected;
}

function denied() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });
  const result = await query(`SELECT o.id,o.status,o.created_at::text,o.updated_at::text,o.completed_at::text,
      p.name AS project_name,c.name AS customer_name,c.email,c.organization,l.opportunity_title,
      COALESCE(json_agg(json_build_object('id',s.id,'task_id',s.task_id,'title',s.title,'status',s.status,'position',s.position,'agent_name',a.name)
        ORDER BY s.position) FILTER (WHERE s.id IS NOT NULL),'[]'::json) AS steps
    FROM customer_onboardings o JOIN projects p ON p.id=o.project_id JOIN contacts c ON c.id=o.contact_id
    JOIN sales_leads l ON l.id=o.sales_lead_id
    LEFT JOIN onboarding_steps s ON s.onboarding_id=o.id
    LEFT JOIN tasks t ON t.id=s.task_id LEFT JOIN agents a ON a.id=t.agent_id
    GROUP BY o.id,p.name,c.name,c.email,c.organization,l.opportunity_title
    ORDER BY CASE WHEN o.status='completed' THEN 1 ELSE 0 END,o.updated_at DESC`);
  return NextResponse.json({ onboardings: result.rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return denied();
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });

  try {
    const body = await request.json();
    const stepId = typeof body?.step_id === "string" ? body.step_id : "";
    const status = typeof body?.status === "string" ? body.status : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stepId)
      || !["todo", "in_progress", "blocked", "done"].includes(status)) {
      return NextResponse.json({ error: "A valid onboarding step and supported status are required." }, { status: 400 });
    }

    const updated = await transaction(async (client) => {
      const stepResult = await client.query<{ id: string; onboarding_id: string; task_id: string | null; title: string; project_id: string }>(
        `SELECT s.id,s.onboarding_id,s.task_id,s.title,o.project_id FROM onboarding_steps s
         JOIN customer_onboardings o ON o.id=s.onboarding_id WHERE s.id=$1 FOR UPDATE OF s`,
        [stepId],
      );
      const step = stepResult.rows[0];
      if (!step) return null;
      await client.query("UPDATE onboarding_steps SET status=$2,updated_at=NOW(),completed_at=CASE WHEN $2='done' THEN NOW() ELSE NULL END WHERE id=$1", [stepId, status]);
      if (step.task_id) {
        const taskStatus = status === "done" ? "done" : status === "in_progress" ? "in_progress" : "todo";
        await client.query("UPDATE tasks SET status=$2,updated_at=NOW() WHERE id=$1", [step.task_id, taskStatus]);
      }
      const counts = await client.query<{ remaining: string }>("SELECT COUNT(*)::text AS remaining FROM onboarding_steps WHERE onboarding_id=$1 AND id<>$2 AND status<>'done'", [step.onboarding_id, stepId]);
      const allDone = status === "done" && Number(counts.rows[0]?.remaining ?? 0) === 0;
      const onboardingStatus = allDone ? "completed" : "in_progress";
      await client.query("UPDATE customer_onboardings SET status=$2,updated_at=NOW(),completed_at=CASE WHEN $2='completed' THEN NOW() ELSE NULL END WHERE id=$1", [step.onboarding_id, onboardingStatus]);
      await client.query(`INSERT INTO events (source,event_type,title,severity,project_id,payload)
        VALUES ('customer-onboarding','onboarding_step_updated',$1,'info',$2,$3::jsonb)`, [
        `Onboarding step ${status}: ${step.title}`,
        step.project_id,
        JSON.stringify({ onboarding_id: step.onboarding_id, step_id: step.id, status }),
      ]);
      return { onboarding_id: step.onboarding_id, step_id: step.id, status, onboarding_status: onboardingStatus };
    });
    if (!updated) return NextResponse.json({ error: "Onboarding step not found." }, { status: 404 });
    return NextResponse.json({ ok: true, ...updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update onboarding step." }, { status: 400 });
  }
}
