import type { Project } from "@/lib/types";
import { StatusDot } from "./StatusDot";

export function ProjectCard({ project }: { project: Project }) {
  return (
    <article className="project-card">
      <div className="project-head">
        <div>
          <div className="project-name">{project.name}</div>
          <div className="project-company">{project.company_name}</div>
        </div>
        <div className="health-chip"><StatusDot status={project.health} /> {project.health}</div>
      </div>
      <p>{project.description}</p>
      <div className="progress-row"><span>{project.progress}%</span><span>{project.stage}</span></div>
      <div className="progress-track"><div className="progress-bar" style={{ width: `${project.progress}%` }} /></div>
    </article>
  );
}
