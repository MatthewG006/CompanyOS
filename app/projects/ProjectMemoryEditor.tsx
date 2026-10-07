"use client";

import { useCallback, useEffect, useState } from "react";

type Project = { id: string; name: string };
type Memory = { project_id: string; project_name: string; title: string | null; content: string | null; updated_at: string | null };

export function ProjectMemoryEditor({ projects, authRequired }: { projects: Project[]; authRequired: boolean }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [contents, setContents] = useState<Record<string, string>>({});
  const [adminToken, setAdminToken] = useState("");
  const [savingProject, setSavingProject] = useState("");
  const [message, setMessage] = useState("");

  const headers = useCallback(() => ({
    "Content-Type": "application/json",
    ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
  }), [adminToken]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/project-memory", { headers: headers(), cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load project memory.");
    const records = (body.memories ?? []) as Memory[];
    setMemories(records);
    setTitles(Object.fromEntries(records.map((record) => [record.project_id, record.title ?? "Shared project memory"])));
    setContents(Object.fromEntries(records.map((record) => [record.project_id, record.content ?? ""])));
  }, [headers]);

  useEffect(() => {
    void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not load project memory."));
  }, [refresh]);

  async function save(project: Project) {
    setSavingProject(project.id);
    setMessage("");
    try {
      const response = await fetch("/api/project-memory", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ project_id: project.id, title: titles[project.id] ?? "Shared project memory", content: contents[project.id] ?? "" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save project memory.");
      setMessage(`${project.name} memory saved. It applies to future agent runs.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save project memory.");
    } finally {
      setSavingProject("");
    }
  }

  return <section className="panel project-memory-panel">
    <div className="panel-head"><div><h2>Shared project memory</h2><p className="muted">Owner notes are included only for agents with the project memory scope. Keep secrets and personal email details out of these notes.</p></div><span className="data-source">OWNER CONTROL</span></div>
    {authRequired ? <label className="router-field policy-token">Admin token<input type="password" autoComplete="current-password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Required by COMPANYOS_ADMIN_TOKEN" /></label> : null}
    {message ? <p className="inline-message" role="status">{message}</p> : null}
    <div className="project-memory-list">{projects.map((project) => {
      const record = memories.find((memory) => memory.project_id === project.id);
      const content = contents[project.id] ?? "";
      return <article className="project-memory-item" key={project.id}>
        <div className="project-memory-heading"><div><strong>{project.name}</strong><span>{record?.updated_at ? `Updated ${new Date(record.updated_at).toLocaleString()}` : "No saved memory"}</span></div>
          <button type="button" className="refresh-button" disabled={savingProject !== "" || content.trim().length === 0 || content.length > 5000 || (authRequired && !adminToken)} onClick={() => void save(project)}>{savingProject === project.id ? "Saving…" : "Save memory"}</button></div>
        <label className="router-field">Memory title<input maxLength={120} value={titles[project.id] ?? "Shared project memory"} onChange={(event) => setTitles((current) => ({ ...current, [project.id]: event.target.value }))} /></label>
        <label className="router-field">Owner notes<textarea maxLength={5000} value={content} onChange={(event) => setContents((current) => ({ ...current, [project.id]: event.target.value }))} placeholder="Goals, decisions, product context, and stable business facts for this project." /></label>
        <div className="memory-character-count">{content.length.toLocaleString()} / 5,000 characters</div>
      </article>;
    })}</div>
  </section>;
}
