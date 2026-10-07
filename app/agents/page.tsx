import { StatusDot } from "@/components/StatusDot";
import { Topbar } from "@/components/Topbar";
import { getDashboardData } from "@/lib/data";
import { AgentConsole } from "./AgentConsole";
import { AgentPolicyEditor } from "./AgentPolicyEditor";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const data = await getDashboardData();
  return <div className="page-wrap"><Topbar title="AI Workforce" subtitle="Run isolated Codex tasks, use configured model APIs, or hand work to ChatGPT Free and Claude Free. Agents can propose approved follow-up tasks." />
    <AgentPolicyEditor agents={data.agents} source={data.source} authRequired={process.env.NODE_ENV !== "production" && Boolean(process.env.COMPANYOS_ADMIN_TOKEN)} writesDisabled={process.env.NODE_ENV === "production" && !process.env.COMPANYOS_ADMIN_TOKEN} />
    <section className="agent-table">
      {data.agents.map((agent) => <div className="agent-row" key={agent.id}><div><strong>{agent.name}</strong><span>{agent.role}</span></div><div>{agent.department}<span>Reports to {agent.manager_name ?? "Owner"}</span></div><div>{agent.provider}<span>Memory: {agent.memory_scope?.length ? agent.memory_scope.join(", ") : "task only"}</span><span>Proposals: {agent.allowed_actions?.length ? agent.allowed_actions.join(", ") : "none"}</span></div><div><StatusDot status={agent.status} /> {agent.status}</div><div className="agent-performance"><strong>{agent.open_task_count ?? 0} open · {agent.completed_task_count ?? 0} tasks done</strong><span>30d runs: {agent.completed_runs_30d ?? 0} completed · {agent.failed_runs_30d ?? 0} failed</span><span>Run success: {agent.run_success_rate_30d == null ? "—" : `${agent.run_success_rate_30d}%`}</span><span>Activity: {agent.last_activity_at ? new Date(agent.last_activity_at).toLocaleString() : "none recorded"}</span></div></div>)}
    </section>
    <div className="agent-console"><AgentConsole tasks={data.tasks} source={data.source} /></div>
  </div>;
}
