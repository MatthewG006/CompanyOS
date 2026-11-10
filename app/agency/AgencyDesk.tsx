"use client";

import { useMemo, useState } from "react";
import type { Agent, Approval, BrandKit, Project, Task } from "@/lib/types";
import { BrandKitEditor } from "./BrandKitEditor";

const DEPARTMENT_ORDER = ["Executive", "Operations", "Technology", "Engineering", "Infrastructure", "Sales", "Marketing", "Customer", "Finance", "Intelligence"];

type Props = {
  projects: Project[];
  agents: Agent[];
  tasks: Task[];
  approvals: Approval[];
  brandKits: BrandKit[];
  authRequired: boolean;
};

export function AgencyDesk({ projects, agents, tasks, approvals, brandKits, authRequired }: Props) {
  const [selected, setSelected] = useState<string>("all");
  const selectedProject = projects.find((project) => project.id === selected);

  const scopedApprovals = useMemo(() => approvals.filter((approval) => !selectedProject || approval.project_name === selectedProject.name), [approvals, selectedProject]);
  const scopedTasks = useMemo(() => tasks.filter((task) => !selectedProject || task.project_name === selectedProject.name), [tasks, selectedProject]);

  const departments = useMemo(() => {
    const names = [...new Set(agents.map((agent) => agent.department))];
    names.sort((a, b) => {
      const ia = DEPARTMENT_ORDER.indexOf(a); const ib = DEPARTMENT_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    return names.map((department) => {
      const members = agents.filter((agent) => agent.department === department);
      const memberNames = new Set(members.map((agent) => agent.name));
      return {
        department,
        members,
        openTasks: scopedTasks.filter((task) => task.agent_name && memberNames.has(task.agent_name)).length,
        pending: scopedApprovals.filter((approval) => memberNames.has(approval.requested_by)).length,
        runs30d: members.reduce((sum, agent) => sum + (agent.completed_runs_30d ?? 0), 0),
        successRates: members.map((agent) => agent.run_success_rate_30d).filter((rate): rate is number => typeof rate === "number"),
      };
    });
  }, [agents, scopedTasks, scopedApprovals]);

  const selectedKit = selectedProject ? brandKits.find((kit) => kit.project_id === selectedProject.id) : undefined;

  return <div>
    <div className="agency-switcher" role="tablist" aria-label="Business">
      <button type="button" role="tab" aria-selected={selected === "all"} className={selected === "all" ? "agency-switch-btn active" : "agency-switch-btn"} onClick={() => setSelected("all")}>All businesses</button>
      {projects.map((project) => <button key={project.id} type="button" role="tab" aria-selected={selected === project.id} className={selected === project.id ? "agency-switch-btn active" : "agency-switch-btn"} onClick={() => setSelected(project.id)}>{project.name}</button>)}
    </div>

    <section className="panel agency-approval-strip">
      <div className="panel-head"><div><h2>You are the editor-in-chief</h2><p className="muted">Every department prepares work; nothing runs until you approve it. Approved tasks are then carried out autonomously by the Codex CLI worker.</p></div><span className="data-source">{scopedApprovals.length} WAITING</span></div>
      {scopedApprovals.length ? <ul className="agency-approval-list">{scopedApprovals.slice(0, 4).map((approval) => <li key={approval.id}><strong>{approval.requested_by}</strong> · {approval.action} <span className="muted">— {approval.project_name} · {approval.risk_level} risk</span></li>)}</ul>
        : <p className="panel-copy">Nothing is waiting for your approval{selectedProject ? ` in ${selectedProject.name}` : ""}. The departments will bring proposals here as they work.</p>}
    </section>

    <div className="project-grid agency-dept-grid">
      {departments.map((dept) => <article className="project-card" key={dept.department}>
        <div className="project-head"><div className="project-name">{dept.department}</div>{dept.pending ? <div className="health-chip">{dept.pending} to approve</div> : null}</div>
        <ul className="dept-agent-list">{dept.members.map((agent) => <li key={agent.id}><strong>{agent.name}</strong> · {agent.role} <span className="muted">— {agent.status}</span></li>)}</ul>
        <div className="project-meta"><span>{dept.openTasks} open tasks</span><span>{dept.pending} pending approvals</span>{selected === "all" ? <span>{dept.runs30d} runs in 30 days</span> : null}</div>
        {selected === "all" && dept.successRates.length ? <p className="muted">Run success (30d): {dept.successRates.map((rate) => `${rate}%`).join(" · ")}</p> : null}
      </article>)}
    </div>

    {selectedProject && selectedKit
      ? <BrandKitEditor kit={selectedKit} authRequired={authRequired} />
      : <div className="project-grid agency-kit-grid">
        {brandKits.map((kit) => <article className="project-card" key={kit.project_id}>
          <div className="project-head"><div className="project-name">{kit.project_name}</div>{kit.logo_url ? /* biome-ignore lint/performance/noImgElement: owner-supplied logo URL on an arbitrary host; next/image needs pre-registered hosts */ <img className="brand-kit-logo" src={kit.logo_url} alt="" /> : null}</div>
          {kit.tagline ? <p>{kit.tagline}</p> : <p className="muted">No brand kit saved yet.</p>}
          <div className="brand-swatch-row">{kit.colors.map((color) => <span key={color} className="brand-swatch" style={{ background: color }} title={color} />)}</div>
          <div className="project-meta"><span>{kit.instagram_username ? `Instagram @${kit.instagram_username}` : "Instagram not set"}</span><span>{kit.services.length} services</span></div>
          <button type="button" className="refresh-button" onClick={() => { const project = projects.find((entry) => entry.id === kit.project_id); if (project) setSelected(project.id); }}>Edit brand kit</button>
        </article>)}
      </div>}
  </div>;
}
