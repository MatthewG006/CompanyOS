"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DashboardData } from "@/lib/types";
import { ApprovalList } from "./ApprovalList";
import { CommandBar } from "./CommandBar";
import { MetricCard } from "./MetricCard";
import { ProjectCard } from "./ProjectCard";
import { StatusDot } from "./StatusDot";

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function AttentionBlock({ data }: { data: DashboardData }) {
  const warnings = data.events.filter((event) => event.severity !== "info");
  return <div className="panel">
    <div className="panel-head"><h2>Owner approvals</h2><span>{data.approvals.length} pending</span></div>
    <ApprovalList initial={data.approvals} />
    {warnings.length ? <div className="subsection"><div className="subsection-title">Warnings</div><div className="list-stack">
      {warnings.slice(0, 6).map((event) => <div className="list-item" key={event.id}><StatusDot status={event.severity} /><div><strong>{event.title}</strong><div className="muted">{event.project_name ?? event.source} · {formatTime(event.created_at)}</div></div></div>)}
    </div></div> : null}
  </div>;
}

export function LiveOverview({ initial }: { initial: DashboardData }) {
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(initial.generated_at);
  const activeAgents = useMemo(() => data.agents.filter((a) => a.status === "working").length, [data.agents]);
  const openTasks = data.tasks.filter((t) => t.status !== "done").length;
  const warnings = data.events.filter((event) => event.severity !== "info").length;
  const unhealthyChecks = data.system_checks.filter((check) => !["healthy", "active"].includes(check.status)).length;
  const attentionItems = data.approvals.length + warnings + unhealthyChecks;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/overview", { cache: "no-store" });
      if (response.ok) {
        const next = await response.json() as DashboardData;
        setData(next);
        setLastRefresh(next.generated_at);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <div className="page-wrap">
    <header className="topbar">
      <div>
        <div className="eyebrow">COMMAND CENTER</div>
        <h1>Company Overview</h1>
        <p>One place to see your businesses, projects, AI workforce, systems and owner decisions.</p>
      </div>
      <div className="topbar-actions">
        <div className="topbar-pill">OWNER VIEW</div>
        <button type="button" className="refresh-button" onClick={refresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</button>
      </div>
    </header>

    <CommandBar />

    <div className="refresh-meta">Database source: <strong>{data.source}</strong> · Last refresh {formatTime(lastRefresh)} · Auto-refresh every 30 seconds</div>

    <section className="metric-grid">
      <MetricCard label="Projects" value={String(data.projects.length)} detail="Active businesses/products" />
      <MetricCard label="AI roles" value={String(data.agents.length)} detail={`${activeAgents} working now`} />
      <MetricCard label="Open tasks" value={String(openTasks)} detail="Across all projects" />
      <MetricCard label="Needs attention" value={String(attentionItems)} detail={`${data.approvals.length} owner approval${data.approvals.length === 1 ? "" : "s"}`} />
    </section>

    <section className="section-block">
      <div className="section-title-row"><div><h2>Connected data</h2><p>Normalized external records currently cached by CompanyOS.</p></div><div className="data-source">{data.external_summary.total} RECORDS</div></div>
      <div className="connection-grid">{data.external_summary.by_provider.map((item) => <div className="connection-card" key={item.provider}><StatusDot status="healthy" /><div><strong>{item.provider}</strong><span>{item.count} cached records</span></div></div>)}{data.external_summary.total === 0 ? <div className="empty-state">No external records yet. Connect an integration from Operations or Communications.</div> : null}</div>
    </section>

    <section className="section-block">
      <div className="section-title-row"><div><h2>Business attention</h2><p>Contacts, upcoming meetings and items that may require action.</p></div><div className="data-source">{data.attention_items.length} OPEN</div></div>
      <div className="two-col">
        <div className="panel"><div className="panel-head"><h2>Attention queue</h2><span>{data.attention_items.length} open</span></div><div className="list-stack">{data.attention_items.slice(0, 6).map((item) => <div className="list-item" key={item.id}><div className={`priority-badge ${item.priority}`}>{item.priority}</div><div><strong>{item.title}</strong><div className="muted">{item.project_name ?? item.source} · {item.contact_name ?? "No contact"}</div></div></div>)}{data.attention_items.length === 0 ? <div className="empty-state">No business attention items.</div> : null}</div></div>
        <div className="panel"><div className="panel-head"><h2>Business context</h2><span>Company Brain</span></div><div className="metric-grid compact-grid"><MetricCard label="Contacts" value={String(data.contacts.length)} detail="Normalized external people" /><MetricCard label="Meetings" value={String(data.meetings.length)} detail="Cached calendar events" /></div></div>
      </div>
    </section>

    <section className="section-block">
      <div className="section-title-row"><div><h2>Projects</h2><p>Business health and delivery progress.</p></div><div className="data-source">DATA: {data.source.toUpperCase()}</div></div>
      <div className="project-grid">{data.projects.map((project) => <ProjectCard key={project.id} project={project} />)}</div>
    </section>

    <section className="two-col">
      <AttentionBlock data={data} />
      <div className="panel">
        <div className="panel-head"><h2>AI workforce</h2><span>{activeAgents} working</span></div>
        <div className="agent-grid">{data.agents.map((agent) => <div className="agent-pill" key={agent.id}><StatusDot status={agent.status} /><div><strong>{agent.name}</strong><span>{agent.role} · {agent.open_task_count ?? 0} open tasks</span></div></div>)}</div>
      </div>
    </section>

    <section className="section-block">
      <div className="section-title-row"><div><h2>Systems & connections</h2><p>What CompanyOS knows about now, and what is ready to connect.</p></div><div className="data-source">CONTROL PLANE</div></div>
      <div className="connection-grid">{data.integrations.map((integration) => <div className="connection-card" key={integration.id}><StatusDot status={integration.status} /><div><strong>{integration.name}</strong><span>{integration.status.replaceAll("_", " ")} · {integration.mode}</span></div></div>)}</div>
    </section>

    <section className="two-col">
      <div className="panel">
        <div className="panel-head"><h2>Recent events</h2><span>Latest 25</span></div>
        <div className="list-stack">{data.events.slice(0, 10).map((event) => <div className="list-item" key={event.id}><StatusDot status={event.severity} /><div><strong>{event.title}</strong><div className="muted">{event.project_name ?? event.source} · {formatTime(event.created_at)}</div></div></div>)}</div>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Priority tasks</h2><span>{openTasks} open</span></div>
        <div className="list-stack">{data.tasks.slice(0, 10).map((task) => <div className="list-item" key={task.id}><div className={`priority-badge ${task.priority}`}>{task.priority}</div><div><strong>{task.title}</strong><div className="muted">{task.project_name ?? "Company"} · {task.agent_name ?? "Unassigned"} · {task.status.replaceAll("_", " ")}</div></div></div>)}</div>
      </div>
    </section>

    <section className="section-block">
      <div className="section-title-row"><div><h2>Financial pulse</h2><p>Month-to-date figures from the Company Brain.</p></div><div className="data-source">MTD</div></div>
      <div className="metric-grid"><MetricCard label="Revenue" value={formatMoney(data.finance.revenue_cents)} /><MetricCard label="Expenses" value={formatMoney(data.finance.expenses_cents)} /><MetricCard label="AI cost" value={formatMoney(data.finance.ai_cost_cents)} /><MetricCard label="Operating result" value={formatMoney(data.finance.profit_cents)} /></div>
    </section>
  </div>;
}
