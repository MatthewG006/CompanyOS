"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminTokenField, useAdminToken } from "@/components/AdminToken";
import type { BrandKit, ContentItem, Project } from "@/lib/types";
import { ContentItemPanel } from "./ContentItemPanel";

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function todayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 10);
}

type Props = {
  projects: Project[];
  brandKits: BrandKit[];
  items: ContentItem[];
  weekStart: string;
  authRequired: boolean;
};

export function PlannerBoard({ projects, brandKits, items, weekStart, authRequired }: Props) {
  const router = useRouter();
  const { token: adminToken } = useAdminToken();
  const [selected, setSelected] = useState<string>("all");
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<ContentItem["type"]>("post");
  const [newProject, setNewProject] = useState<string>("");
  const [newDate, setNewDate] = useState("");

  const headers = {
    "Content-Type": "application/json",
    ...(adminToken ? { Authorization: `Bearer ${adminToken}`, "x-companyos-admin-token": adminToken } : {}),
  };

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const inScope = (item: ContentItem) => selected === "all" || item.project_id === selected;
  const scoped = items.filter(inScope);
  const ideas = scoped.filter((item) => !item.scheduled_for && item.status !== "published");
  const due = scoped.filter((item) => item.status === "scheduled" && item.scheduled_for && item.scheduled_for < todayIso());
  const selectedItem = items.find((item) => item.id === selectedItemId);
  const selectedKit = selectedItem ? brandKits.find((kit) => kit.project_id === selectedItem.project_id) : undefined;
  const reviewCount = scoped.filter((item) => item.status === "in_review").length;

  async function approveWeek() {
    const targets = selected === "all" ? projects : projects.filter((project) => project.id === selected);
    setBusy(true); setMessage("");
    try {
      let total = 0;
      for (const project of targets) {
        const res = await fetch("/api/content", { method: "PATCH", headers, body: JSON.stringify({ bulk: "approve_week", project_id: project.id, week_start: weekStart }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Could not approve the week.");
        total += data.approved ?? 0;
      }
      setMessage(total ? `Approved ${total} item${total === 1 ? "" : "s"} for this week.` : "Nothing in review for this week.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not approve the week.");
    } finally { setBusy(false); }
  }

  async function createItem() {
    const projectId = newProject || projects[0]?.id || "";
    if (!projectId || newTitle.trim().length < 3) { setMessage("Give the item a title of at least 3 characters."); return; }
    setBusy(true); setMessage("");
    try {
      const res = await fetch("/api/content", { method: "POST", headers, body: JSON.stringify({ project_id: projectId, type: newType, title: newTitle.trim(), scheduled_for: newDate || null }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not create the item.");
      setNewTitle(""); setNewDate("");
      setMessage("Added as a draft. Fill in the caption and image prompt, then approve and schedule it.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create the item.");
    } finally { setBusy(false); }
  }

  const card = (item: ContentItem) => <button key={item.id} type="button" className={item.id === selectedItemId ? "planner-card active" : "planner-card"} onClick={() => setSelectedItemId(item.id)}>
    <span className="planner-card-type">{item.type.toUpperCase()}</span>
    <span className="planner-card-title">{item.title}</span>
    <span className="planner-card-meta">{selected === "all" ? `${item.project_name} · ` : ""}{item.status.replace("_", " ")}{item.image_options.length ? ` · ${item.image_options.length} variations` : ""}{item.image_url ? " · visual ✓" : ""}</span>
  </button>;

  return <div>
    <div className="agency-switcher" role="tablist" aria-label="Business">
      <button type="button" role="tab" aria-selected={selected === "all"} className={selected === "all" ? "agency-switch-btn active" : "agency-switch-btn"} onClick={() => setSelected("all")}>All businesses</button>
      {projects.map((project) => <button key={project.id} type="button" role="tab" aria-selected={selected === project.id} className={selected === project.id ? "agency-switch-btn active" : "agency-switch-btn"} onClick={() => setSelected(project.id)}>{project.name}</button>)}
    </div>

    <div className="planner-toolbar">
      <div className="planner-weeknav">
        <Link className="refresh-button" href={`/planner?week=${addDays(weekStart, -7)}`}>← Prev week</Link>
        <span className="planner-week-label">Week of {dayLabel(weekStart)}</span>
        <Link className="refresh-button" href={`/planner?week=${addDays(weekStart, 7)}`}>Next week →</Link>
      </div>
      <div className="planner-toolbar-actions">
        <span className="muted">{reviewCount} in review</span>
        <button type="button" className="refresh-button" disabled={busy || reviewCount === 0 || (authRequired && !adminToken)} onClick={() => void approveWeek()}>Approve this week</button>
      </div>
    </div>
    {authRequired ? <AdminTokenField /> : null}
    {message ? <p className="inline-message" role="status">{message}</p> : null}
    {due.length ? <p className="inline-message planner-due" role="alert">Due to publish: {due.map((item) => `${item.title} (${item.project_name}, ${item.scheduled_for})`).join(" · ")}</p> : null}

    <div className="planner-week">
      {days.map((day) => <div className="planner-day" key={day}>
        <div className="planner-day-head">{dayLabel(day)}</div>
        {scoped.filter((item) => item.scheduled_for === day).map(card)}
      </div>)}
      <div className="planner-day planner-ideas">
        <div className="planner-day-head">Ideas · unscheduled</div>
        {ideas.map(card)}
      </div>
    </div>

    <section className="panel planner-create">
      <div className="panel-head"><div><h2>Add an idea</h2><p className="muted">Your agents propose most content through approvals; add your own here any time.</p></div></div>
      <div className="brand-kit-actions">
        <label className="router-field">Business<select value={newProject || projects[0]?.id || ""} onChange={(event) => setNewProject(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label className="router-field">Type<select value={newType} onChange={(event) => setNewType(event.target.value as ContentItem["type"])}><option value="post">Post</option><option value="reel">Reel</option><option value="story">Story</option><option value="article">Article</option></select></label>
        <label className="router-field brand-kit-website">Title<input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} maxLength={160} placeholder="What is this content about?" /></label>
        <label className="router-field">Date<input type="date" value={newDate} onChange={(event) => setNewDate(event.target.value)} /></label>
        <button type="button" className="refresh-button" disabled={busy || (authRequired && !adminToken)} onClick={() => void createItem()}>Add draft</button>
      </div>
    </section>

    {selectedItem ? <ContentItemPanel key={selectedItem.id} item={selectedItem} kit={selectedKit} authRequired={authRequired} /> : null}
  </div>;
}
