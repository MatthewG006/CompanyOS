import { StatusDot } from "@/components/StatusDot";
import { Topbar } from "@/components/Topbar";
import { getDashboardData } from "@/lib/data";
import { ProjectMemoryEditor } from "./ProjectMemoryEditor";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const data = await getDashboardData();
  return <div className="page-wrap">
    <Topbar title="Projects" subtitle="Live project state from the Company Brain." />
    <div className="project-grid">
      {data.projects.map((project) => <article className="project-card" key={project.id}>
        <div className="project-head"><div><div className="project-name">{project.name}</div><div className="project-company">{project.company_name}</div></div><div className="health-chip"><StatusDot status={project.health} /> {project.health}</div></div>
        <p>{project.description}</p>
        <div className="project-meta"><span>{project.open_task_count ?? 0} open tasks</span><span>{project.task_count ?? 0} total tasks</span><span>{project.stage}</span></div>
        <div className="progress-row"><span>{project.progress}% complete</span><span>{project.stage}</span></div><div className="progress-track"><div className="progress-bar" style={{ width: `${project.progress}%` }} /></div>
      </article>)}
    </div>
    <div className="project-memory-wrap"><ProjectMemoryEditor projects={data.projects.map(({ id, name }) => ({ id, name }))} authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)} /></div>
  </div>;
}
