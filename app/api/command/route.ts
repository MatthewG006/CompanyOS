import { NextResponse } from "next/server";
import { databaseAvailable, query } from "@/lib/db";
import { getDashboardData } from "@/lib/data";

export const dynamic = "force-dynamic";

async function logCommand(command: string, route: string, status: string, response: string) {
  if (!(await databaseAvailable())) return;
  try {
    await query(`INSERT INTO command_runs (command, route, status, response) VALUES ($1,$2,$3,$4)`, [command, route, status, response]);
  } catch {
    // Logging must never break a command.
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const command = typeof body?.command === "string" ? body.command.trim() : "";
    if (!command) return NextResponse.json({ message: "Enter a command." }, { status: 400 });

    const data = await getDashboardData();
    const lower = command.toLowerCase();
    let message = "";
    let route = "help";

    if (lower.includes("attention") || lower.includes("needs my attention")) {
      const warnings = data.events.filter((e) => e.severity !== "info").length;
      const unhealthy = data.system_checks.filter((check) => !["healthy", "active"].includes(check.status)).length;
      message = `Attention queue: ${data.approvals.length} owner approval(s), ${warnings} warning event(s), ${unhealthy} non-healthy system check(s), and ${data.tasks.length} open task(s).`;
      route = "attention";
    } else if (lower.includes("project")) {
      message = `CompanyOS currently tracks ${data.projects.length} projects: ${data.projects.map((p) => p.name).join(", ")}.`;
      route = "projects";
    } else if (lower.includes("agent") || lower.includes("workforce")) {
      const working = data.agents.filter((agent) => agent.status === "working");
      message = `${data.agents.length} AI roles are registered. ${working.length} are marked working: ${working.map((agent) => agent.name).join(", ") || "none"}.`;
      route = "agents";
    } else if (lower.includes("system") || lower.includes("health")) {
      const bad = data.system_checks.filter((check) => !["healthy", "active"].includes(check.status));
      message = bad.length ? `${bad.length} system check(s) need attention: ${bad.map((check) => `${check.system_name} (${check.status})`).join(", ")}.` : "All recorded system checks are healthy or active.";
      route = "health";
    } else if (lower.includes("finance") || lower.includes("revenue")) {
      const dollars = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
      message = `Month-to-date: revenue ${dollars(data.finance.revenue_cents)}, expenses ${dollars(data.finance.expenses_cents)}, AI cost ${dollars(data.finance.ai_cost_cents)}, operating result ${dollars(data.finance.profit_cents)}.`;
      route = "finance";
    } else if (lower.startsWith("create task") || lower.startsWith("add task")) {
      if (data.source !== "database") {
        message = "Task creation requires the PostgreSQL Company Brain to be available.";
        route = "task-create-unavailable";
      } else {
        const title = command.replace(/^(create task|add task)\s*[:-]?\s*/i, "").trim();
        if (!title) {
          message = "Use: Create task: <task title>";
          route = "task-create-help";
        } else {
          const inserted = await query<{ id: string }>(`INSERT INTO tasks (title, priority, status) VALUES ($1,'normal','todo') RETURNING id`, [title]);
          await query(`INSERT INTO events (source,event_type,title,severity,payload) VALUES ('command-center','task_created',$1,'info',$2::jsonb)`, [`Task created: ${title}`, JSON.stringify({ task_id: inserted.rows[0].id })]);
          message = `Created task: ${title}.`;
          route = "task-create";
        }
      }
    } else if (lower.includes("email") || lower.includes("mail")) {
      const records = data.external_records.filter((item) => item.record_type === "email");
      message = records.length ? `CompanyOS has ${records.length} synchronized email record(s) in the dashboard cache. The most recent is: ${records[0].title}.` : "No synchronized Gmail records are stored yet. Connect Google locally, then run Gmail sync.";
      route = "email";
    } else if (lower.includes("calendar") || lower.includes("schedule") || lower.includes("meeting")) {
      const records = data.external_records.filter((item) => item.record_type === "calendar_event");
      message = records.length ? `CompanyOS has ${records.length} synchronized calendar event(s). The next stored event is: ${records[0].title}.` : "No synchronized Calendar records are stored yet. Connect Google locally, then run Calendar sync.";
      route = "calendar";
    } else if (lower.includes("github") || lower.includes("repository") || lower.includes("pull request")) {
      const records = data.external_records.filter((item) => item.provider === "github");
      message = records.length ? `CompanyOS has ${records.length} synchronized GitHub record(s), including ${records.filter((item) => item.record_type === "repository").length} repositories.` : "No GitHub records are stored yet. Configure GITHUB_TOKEN and run GitHub sync.";
      route = "github";
    } else if (lower.includes("sync")) {
      message = "Use Operations → Integration control to run configured collectors. Background sync will be connected to n8n in the next workflow milestone.";
      route = "sync";
    } else if (lower.includes("integration")) {
      message = `Integration registry: ${data.integrations.map((item) => `${item.name}=${item.status}`).join(" · ")}.`;
      route = "integrations";
    } else {
      message = "Try: Show me everything that needs my attention · List projects · Show AI workforce · Check system health · Show finance · Create task: <title> · Show integrations.";
    }

    await logCommand(command, route, "completed", message);
    return NextResponse.json({ message, route, source: data.source, generated_at: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid command request.";
    return NextResponse.json({ message }, { status: 400 });
  }
}
