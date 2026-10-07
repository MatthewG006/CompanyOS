import { NextResponse } from "next/server";
import { databaseAvailable, query } from "@/lib/db";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  if (process.env.NODE_ENV === "production" && request.headers.get("x-companyos-owner-authenticated") === "true") return true;
  const expected = process.env.COMPANYOS_ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`
    || request.headers.get("x-companyos-admin-token") === expected;
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await databaseAvailable())) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });

  const result = await query(`SELECT wd.id,wd.workflow_key,wd.status AS workflow_status,wd.created_at::text,
      er.payload->>'category' AS category,ai.priority,p.name AS project_name,a.name AS agent_name,
      t.title AS task_title,t.status AS task_status,r.id AS agent_run_id,r.status AS agent_run_status,
      r.summary AS run_summary,r.error AS run_error,r.started_at::text AS run_started_at,r.completed_at::text AS run_completed_at
    FROM workflow_dispatches wd
    JOIN attention_items ai ON ai.id=wd.attention_item_id
    LEFT JOIN external_records er ON er.id=ai.external_record_id
    LEFT JOIN projects p ON p.id=wd.project_id
    LEFT JOIN agents a ON a.id=wd.agent_id
    LEFT JOIN tasks t ON t.id=wd.task_id
    LEFT JOIN agent_runs r ON r.id=wd.agent_run_id
    WHERE wd.workflow_key='gmail_attention_to_agent_task_v1'
      AND wd.status <> 'existing_at_enablement'
    ORDER BY wd.created_at DESC
    LIMIT 50`);

  return NextResponse.json({ workflows: result.rows, auth_required: process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN) });
}
