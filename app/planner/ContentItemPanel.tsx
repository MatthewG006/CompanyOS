"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AdminTokenField, useAdminToken } from "@/components/AdminToken";
import type { BrandKit, ContentItem } from "@/lib/types";

// biome-ignore lint/performance/noImgElement: studio image URLs live on arbitrary hosts; next/image needs pre-registered hosts
const StudioImage = ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />;

export function ContentItemPanel({ item, kit, authRequired }: { item: ContentItem; kit?: BrandKit; authRequired: boolean }) {
  const router = useRouter();
  const { token: adminToken } = useAdminToken();
  const [title, setTitle] = useState(item.title);
  const [caption, setCaption] = useState(item.caption);
  const [imagePrompt, setImagePrompt] = useState(item.image_prompt);
  const [scheduledFor, setScheduledFor] = useState(item.scheduled_for ?? "");
  const [status, setStatus] = useState(item.status);
  const [publishedUrl, setPublishedUrl] = useState(item.published_url);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const headers = {
    "Content-Type": "application/json",
    ...(adminToken ? { Authorization: `Bearer ${adminToken}`, "x-companyos-admin-token": adminToken } : {}),
  };

  async function patch(payload: Record<string, unknown>, success: string) {
    setBusy("save"); setMessage("");
    try {
      const res = await fetch("/api/content", { method: "PATCH", headers, body: JSON.stringify({ id: item.id, ...payload }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save the item.");
      setMessage(success);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the item.");
    } finally { setBusy(""); }
  }

  const save = () => void patch({ title, caption, image_prompt: imagePrompt, scheduled_for: scheduledFor || null, status, published_url: publishedUrl }, "Saved.");
  const approveImage = (url: string) => void patch({ image_url: url }, "Image approved for this item.");

  return <section className="panel content-panel">
    <div className="panel-head"><div><h2>{item.type.toUpperCase()} — {item.project_name}</h2><p className="muted">Proposed by {item.created_by}. {item.type === "article" ? "Articles publish through the WordPress flow." : kit?.instagram_username ? `Publishes to Instagram @${kit.instagram_username}.` : "Add this business's Instagram username to its brand kit so it can publish."}</p></div><span className="data-source">{item.status.replace("_", " ").toUpperCase()}</span></div>
    {authRequired ? <AdminTokenField /> : null}
    {message ? <p className="inline-message" role="status">{message}</p> : null}
    <div className="brand-kit-grid">
      <label className="router-field">Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} /></label>
      <label className="router-field">Scheduled date<input type="date" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} /></label>
      <label className="router-field">Status<select value={status} onChange={(event) => setStatus(event.target.value as ContentItem["status"])}>
        <option value="draft">Draft</option><option value="in_review">In review</option><option value="approved">Approved</option><option value="scheduled">Scheduled</option><option value="published">Published</option>
      </select></label>
      <label className="router-field">Published URL<input value={publishedUrl} onChange={(event) => setPublishedUrl(event.target.value)} placeholder="https://www.instagram.com/p/…" /></label>
    </div>
    <label className="router-field">Caption<textarea value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={2200} rows={3} /></label>
    <label className="router-field">Image prompt (for the design studio)<textarea value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} maxLength={500} rows={2} placeholder="Describe the visual — the studio generates variations from this" /></label>

    <div className="studio-block">
      <div className="subsection-title">Design studio</div>
      {item.image_url ? <div className="studio-chosen"><StudioImage src={item.image_url} alt="Approved visual for this item" /><span className="muted">Approved visual</span></div> : <p className="muted">No visual approved yet. Variations generated from the image prompt appear here for your approval — nothing replaces the visual without your yes.</p>}
      {item.image_options.length ? <div className="studio-options">{item.image_options.map((url) => <div className="studio-option" key={url}><StudioImage src={url} alt="Design variation" /><button type="button" className="refresh-button" disabled={busy !== "" || (authRequired && !adminToken)} onClick={() => approveImage(url)}>Approve this visual</button></div>)}</div> : null}
    </div>

    <div className="content-actions">
      <button type="button" className="refresh-button" disabled={busy !== "" || (authRequired && !adminToken)} onClick={save}>{busy === "save" ? "Saving…" : "Save item"}</button>
      {status !== "approved" && item.status !== "published" ? <button type="button" className="refresh-button" disabled={busy !== "" || (authRequired && !adminToken)} onClick={() => { setStatus("approved"); void patch({ status: "approved" }, "Approved. Schedule it when the date is set."); }}>Approve</button> : null}
      {item.status !== "published" ? <button type="button" className="refresh-button" disabled={busy !== "" || !scheduledFor || (authRequired && !adminToken)} onClick={() => { setStatus("scheduled"); void patch({ status: "scheduled", scheduled_for: scheduledFor || null }, "Scheduled. It will be due to publish on that date."); }}>Schedule</button> : null}
    </div>
  </section>;
}
