"use client";

import { useMemo, useState } from "react";
import type { ContentItem, LeadOutcome, Project, SalesLeadRow } from "@/lib/types";

const THIRTY_DAYS = 30 * 24 * 3_600_000;

function money(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function humanMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 60 * 48) return `${(minutes / 60).toFixed(1)} hours`;
  return `${(minutes / (60 * 24)).toFixed(1)} days`;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type Props = { projects: Project[]; leads: SalesLeadRow[]; outcomes: LeadOutcome[]; contentItems: ContentItem[] };

export function ResultsBoard({ projects, leads, outcomes, contentItems }: Props) {
  const [selected, setSelected] = useState<string>("all");
  const selectedProject = projects.find((project) => project.id === selected);

  const scopedLeads = useMemo(() => leads.filter((lead) => !selectedProject || lead.project_id === selectedProject.id || lead.project_name === selectedProject.name), [leads, selectedProject]);
  const scopedOutcomes = useMemo(() => outcomes.filter((outcome) => !selectedProject || outcome.project_name === selectedProject.name), [outcomes, selectedProject]);
  const scopedContent = useMemo(() => contentItems.filter((item) => !selectedProject || item.project_id === selectedProject.id || item.project_name === selectedProject.name), [contentItems, selectedProject]);

  const cutoff = Date.now() - THIRTY_DAYS;
  const received30 = scopedLeads.filter((lead) => new Date(lead.created_at).getTime() >= cutoff);
  const contacted = scopedLeads.filter((lead) => lead.first_contacted_at);
  const quoted = scopedOutcomes.filter((outcome) => outcome.outcome === "quote").length;
  const won = scopedLeads.filter((lead) => lead.stage === "won");
  const lost = scopedLeads.filter((lead) => lead.stage === "lost");
  const decided = won.length + lost.length;
  const winRate = decided ? Math.round((won.length / decided) * 100) : null;
  const responseMinutes = contacted
    .map((lead) => (new Date(lead.first_contacted_at as string).getTime() - new Date(lead.created_at).getTime()) / 60_000)
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0);
  const medianResponse = median(responseMinutes);
  const unanswered = scopedLeads.filter((lead) => lead.stage === "new" && !lead.first_contacted_at);
  const pipelineCents = scopedLeads.filter((lead) => !["won", "lost"].includes(lead.stage)).reduce((sum, lead) => sum + Number(lead.estimated_value_cents || 0), 0);
  const wonCents = won.reduce((sum, lead) => sum + Number(lead.estimated_value_cents || 0), 0);
  const published30 = scopedContent.filter((item) => item.status === "published" && item.updated_at && new Date(item.updated_at).getTime() >= cutoff).length;
  const scheduled = scopedContent.filter((item) => item.status === "scheduled").length;

  const kpis: Array<{ value: string; label: string; sub?: string }> = [
    { value: String(received30.length), label: "Leads received · 30 days", sub: `${scopedLeads.length} all time` },
    { value: String(contacted.length), label: "Contacted", sub: unanswered.length ? `${unanswered.length} still waiting for a first response` : "Every lead has a first response" },
    { value: medianResponse === null ? "—" : humanMinutes(medianResponse), label: "Median first response", sub: "From lead created to first contact" },
    { value: String(quoted), label: "Quotes sent", sub: "Outcome reports, all time" },
    { value: String(won.length), label: "Won", sub: winRate === null ? undefined : `${winRate}% of decided leads` },
    { value: String(lost.length), label: "Lost" },
    { value: money(pipelineCents), label: "Open pipeline value" },
    { value: money(wonCents), label: "Won value" },
    { value: String(published30), label: "Content published · 30 days", sub: `${scheduled} scheduled and coming` },
  ];

  return <div>
    <div className="agency-switcher" role="tablist" aria-label="Business">
      <button type="button" role="tab" aria-selected={selected === "all"} className={selected === "all" ? "agency-switch-btn active" : "agency-switch-btn"} onClick={() => setSelected("all")}>All businesses</button>
      {projects.map((project) => <button key={project.id} type="button" role="tab" aria-selected={selected === project.id} className={selected === project.id ? "agency-switch-btn active" : "agency-switch-btn"} onClick={() => setSelected(project.id)}>{project.name}</button>)}
    </div>

    <div className="results-grid">
      {kpis.map((kpi) => <div className="results-kpi" key={kpi.label}><div className="results-kpi-value">{kpi.value}</div><div className="results-kpi-label">{kpi.label}</div>{kpi.sub ? <div className="results-kpi-sub">{kpi.sub}</div> : null}</div>)}
    </div>

    <section className="panel">
      <div className="panel-head"><div><h2>Latest outcomes</h2><p className="muted">One-tap result reports from the pipeline — this is what proves the program sells.</p></div><span className="data-source">{scopedOutcomes.length} REPORTS</span></div>
      {scopedOutcomes.length ? <ul className="results-feed">{scopedOutcomes.slice(0, 12).map((outcome) => <li key={outcome.id}><strong>{outcome.outcome.toUpperCase()}</strong> · {outcome.opportunity_title} <span className="muted">— {outcome.project_name} · {new Date(outcome.created_at).toLocaleString()}</span></li>)}</ul>
        : <p className="panel-copy">No outcomes reported yet{selectedProject ? ` for ${selectedProject.name}` : ""}. Record them from the outcome buttons on any lead in the Sales pipeline.</p>}
    </section>
  </div>;
}
