"use client";

import { useState } from "react";
import type { Agent } from "@/lib/types";

type Action = "request_task_creation" | "request_task_status_change" | "request_task_delegation" | "request_financial_entry" | "request_sales_lead" | "request_email_outreach" | "request_support_case_update";
type Scope = "project" | "tasks" | "systems" | "sales" | "support";
type ProviderOption = "agnostic" | "chatgpt-free" | "claude-free" | "codex" | "codex-cli" | "ollama" | "openai" | "anthropic";
type Policy = { allowed_actions: Action[]; memory_scope: Scope[]; provider: ProviderOption };

const actions: Array<{ value: Action; label: string }> = [
  { value: "request_task_creation", label: "Propose task creation" },
  { value: "request_task_status_change", label: "Propose task status changes" },
  { value: "request_task_delegation", label: "Propose delegation to a direct report" },
  { value: "request_financial_entry", label: "Propose sales income for owner approval" },
  { value: "request_sales_lead", label: "Propose a lead from Gmail for owner approval" },
  { value: "request_email_outreach", label: "Draft sales email for owner approval before sending" },
  { value: "request_support_case_update", label: "Propose support case status changes for owner approval" },
];
const scopes: Array<{ value: Scope; label: string }> = [
  { value: "project", label: "Assigned project summary" },
  { value: "tasks", label: "Assigned project tasks" },
  { value: "systems", label: "Assigned project system checks" },
  { value: "sales", label: "Sales contacts and emails (PII; grant only to Sales)" },
  { value: "support", label: "Assigned support case details (customer data; grant only to Support)" },
];

const providerOptions: Array<{ value: ProviderOption; label: string }> = [
  { value: "agnostic", label: "Agnostic · auto router" },
  { value: "chatgpt-free", label: "ChatGPT Free · manual handoff" },
  { value: "claude-free", label: "Claude Free · manual handoff" },
  { value: "codex", label: "Codex · manual handoff" },
  { value: "codex-cli", label: "Codex CLI · local isolated" },
  { value: "ollama", label: "Ollama · local model" },
  { value: "openai", label: "OpenAI API" },
  { value: "anthropic", label: "Anthropic API" },
];

function initialPolicies(agents: Agent[]) {
  return Object.fromEntries(agents.map((agent) => [agent.id, {
    allowed_actions: (agent.allowed_actions ?? []).filter((value): value is Action => actions.some((action) => action.value === value)),
    memory_scope: (agent.memory_scope ?? []).filter((value): value is Scope => scopes.some((scope) => scope.value === value)),
    provider: (agent.provider as ProviderOption) || "agnostic",
  }])) as Record<string, Policy>;
}

export function AgentPolicyEditor({ agents, source, authRequired, writesDisabled }: { agents: Agent[]; source: "database" | "demo"; authRequired: boolean; writesDisabled: boolean }) {
  const [policies, setPolicies] = useState<Record<string, Policy>>(() => initialPolicies(agents));
  const [adminToken, setAdminToken] = useState("");
  const [savingAgent, setSavingAgent] = useState("");
  const [messages, setMessages] = useState<Record<string, string>>({});

  function toggle(agentId: string, key: "allowed_actions" | "memory_scope", value: Action | Scope) {
    setPolicies((current) => {
      const policy = current[agentId];
      const list = policy[key] as Array<Action | Scope>;
      const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
      return { ...current, [agentId]: { ...policy, [key]: next } };
    });
  }

  function setAgentProvider(agentId: string, provider: ProviderOption) {
    setPolicies((current) => ({
      ...current,
      [agentId]: { ...current[agentId], provider },
    }));
  }

  async function save(agent: Agent) {
    const policy = policies[agent.id];
    setSavingAgent(agent.id);
    setMessages((current) => ({ ...current, [agent.id]: "" }));
    try {
      const response = await fetch("/api/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) },
        body: JSON.stringify({ agent_id: agent.id, ...policy }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save agent policy.");
      setMessages((current) => ({ ...current, [agent.id]: "Saved. Applies to new runs." }));
    } catch (error) {
      setMessages((current) => ({ ...current, [agent.id]: error instanceof Error ? error.message : "Could not save agent policy." }));
    } finally {
      setSavingAgent("");
    }
  }

  return <section className="panel agent-policy-panel">
    <div className="panel-head"><div><h2>Agent permissions & memory</h2><p className="muted">Configure execution provider, proposal permissions, and memory scopes. Task proposals still require owner approval.</p></div><span className="data-source">OWNER CONTROL</span></div>
    {authRequired ? <label className="router-field policy-token">Admin token<input type="password" autoComplete="current-password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
    {source === "demo" ? <p className="queue-note">Connect PostgreSQL to manage agent policy.</p> : writesDisabled ? <p className="queue-note">Configure COMPANYOS_ADMIN_TOKEN before enabling policy changes in production.</p> : null}
    <div className="policy-list">{agents.map((agent) => {
      const policy = policies[agent.id];
      return <article className="policy-row" key={agent.id}>
        <div className="policy-heading"><div><strong>{agent.name}</strong><span>{agent.role} · reports to {agent.manager_name ?? "Owner"}</span></div>
          <button type="button" className="refresh-button" disabled={source !== "database" || Boolean(savingAgent) || (authRequired && !adminToken) || writesDisabled} onClick={() => void save(agent)}>{savingAgent === agent.id ? "Saving..." : "Save policy"}</button></div>
        <div className="policy-provider-row" style={{ marginTop: "0.75rem", marginBottom: "0.75rem" }}>
          <label className="router-field" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontWeight: 600, minWidth: "150px" }}>Assigned Provider:</span>
            <select
              value={policy.provider}
              onChange={(e) => setAgentProvider(agent.id, e.target.value as ProviderOption)}
              disabled={source !== "database" || Boolean(savingAgent)}
              style={{ flex: 1, padding: "0.4rem 0.6rem", background: "var(--bg-input, #18181b)", color: "var(--fg, #f4f4f5)", border: "1px solid var(--border, #3f3f46)", borderRadius: "6px" }}
            >
              {providerOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="policy-groups">
          <fieldset className="policy-fieldset"><legend>Allowed proposals</legend>{actions.map((action) => <label key={action.value}><input type="checkbox" checked={policy.allowed_actions.includes(action.value)} onChange={() => toggle(agent.id, "allowed_actions", action.value)} disabled={source !== "database" || Boolean(savingAgent)} />{action.label}</label>)}</fieldset>
          <fieldset className="policy-fieldset"><legend>Company Brain memory</legend>{scopes.map((scope) => <label key={scope.value}><input type="checkbox" checked={policy.memory_scope.includes(scope.value)} onChange={() => toggle(agent.id, "memory_scope", scope.value)} disabled={source !== "database" || Boolean(savingAgent)} />{scope.label}</label>)}</fieldset>
        </div>
        {messages[agent.id] ? <p className="inline-message" role="status">{messages[agent.id]}</p> : null}
      </article>;
    })}</div>
  </section>;
}
