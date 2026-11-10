"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AdminTokenField, useAdminToken } from "@/components/AdminToken";
import type { BrandKit } from "@/lib/types";

const splitList = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

export function BrandKitEditor({ kit, authRequired }: { kit: BrandKit; authRequired: boolean }) {
  const router = useRouter();
  const { token: adminToken } = useAdminToken();
  const [website, setWebsite] = useState(kit.website_url);
  const [logoUrl, setLogoUrl] = useState(kit.logo_url);
  const [tagline, setTagline] = useState(kit.tagline);
  const [phone, setPhone] = useState(kit.phone);
  const [serviceArea, setServiceArea] = useState(kit.service_area);
  const [instagram, setInstagram] = useState(kit.instagram_username);
  const [colorsText, setColorsText] = useState(kit.colors.join(", "));
  const [fontsText, setFontsText] = useState(kit.fonts.join(", "));
  const [servicesText, setServicesText] = useState(kit.services.join(", "));
  const [fromWebsite, setFromWebsite] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const headers = {
    "Content-Type": "application/json",
    ...(adminToken ? { Authorization: `Bearer ${adminToken}`, "x-companyos-admin-token": adminToken } : {}),
  };
  const colors = splitList(colorsText);

  async function readFromWebsite() {
    if (!website.trim()) { setMessage("Paste the business website above first, then read it."); return; }
    setBusy("read"); setMessage("");
    try {
      const res = await fetch("/api/brand-kits/extract", { method: "POST", headers, body: JSON.stringify({ url: website.trim() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not read that website.");
      const found = data.extraction;
      if (found.logo_url) setLogoUrl(found.logo_url);
      if (found.tagline) setTagline(found.tagline);
      if (found.phone) setPhone(found.phone);
      if (found.instagram_username) setInstagram(found.instagram_username);
      if (found.colors?.length) setColorsText(found.colors.join(", "));
      if (found.fonts?.length) setFontsText(found.fonts.join(", "));
      setFromWebsite(true);
      setMessage("Filled from the website — review everything, then Save brand kit. Nothing was saved yet.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not read that website.");
    } finally { setBusy(""); }
  }

  async function save() {
    setBusy("save"); setMessage("");
    try {
      const res = await fetch("/api/brand-kits", {
        method: "PUT", headers,
        body: JSON.stringify({
          project_id: kit.project_id, website_url: website, logo_url: logoUrl, tagline, phone,
          service_area: serviceArea, instagram_username: instagram,
          colors, fonts: splitList(fontsText), services: splitList(servicesText),
          source: fromWebsite ? "website" : "manual",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save the brand kit.");
      setMessage("Brand kit saved. Agents with the project scope now design and write with it.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the brand kit.");
    } finally { setBusy(""); }
  }

  return <section className="panel brand-kit-panel">
    <div className="panel-head"><div><h2>Brand kit — {kit.project_name}</h2><p className="muted">The identity your departments design and write with. Paste the website and read it automatically, or fill the kit in by hand.</p></div><span className="data-source">{kit.updated_at ? `UPDATED ${new Date(kit.updated_at).toLocaleDateString()}` : "NOT SAVED YET"}</span></div>
    {authRequired ? <AdminTokenField /> : null}
    {message ? <p className="inline-message" role="status">{message}</p> : null}
    <div className="brand-kit-actions">
      <label className="router-field brand-kit-website">Business website<input value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://yourbusiness.example" maxLength={300} /></label>
      <button type="button" className="refresh-button" disabled={busy !== "" || (authRequired && !adminToken)} onClick={() => void readFromWebsite()}>{busy === "read" ? "Reading…" : "Read from website"}</button>
    </div>
    <div className="brand-kit-grid">
      <label className="router-field">Tagline<input value={tagline} onChange={(event) => setTagline(event.target.value)} maxLength={160} /></label>
      <label className="router-field">Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={40} /></label>
      <label className="router-field">Service area<input value={serviceArea} onChange={(event) => setServiceArea(event.target.value)} maxLength={200} placeholder="Counties or towns served" /></label>
      <label className="router-field">Instagram username<input value={instagram} onChange={(event) => setInstagram(event.target.value)} maxLength={40} placeholder="businesshandle" /></label>
      <label className="router-field">Logo URL<input value={logoUrl} onChange={(event) => setLogoUrl(event.target.value)} maxLength={500} placeholder="https://…/logo.png" /></label>
      <label className="router-field">Colors (comma separated)<input value={colorsText} onChange={(event) => setColorsText(event.target.value)} placeholder="#1e3a5f, #38bdf8, #f8fafc" /></label>
      <label className="router-field">Fonts (comma separated)<input value={fontsText} onChange={(event) => setFontsText(event.target.value)} placeholder="Montserrat, Inter" /></label>
      <label className="router-field">Services (comma separated)<input value={servicesText} onChange={(event) => setServicesText(event.target.value)} placeholder="Design, Web, Branding" /></label>
    </div>
    <div className="brand-kit-preview">
      {logoUrl ? /* biome-ignore lint/performance/noImgElement: owner-supplied logo URL on an arbitrary host; next/image needs pre-registered hosts */ <img className="brand-kit-logo" src={logoUrl} alt={`${kit.project_name} logo`} /> : null}
      <div className="brand-swatch-row">{colors.length ? colors.map((color) => <span key={color} className="brand-swatch" style={{ background: color }} title={color} />) : <span className="muted">No colors yet</span>}</div>
      <span className="muted">{instagram ? `Posts publish through the connected Instagram account @${instagram.replace(/^@+/, "")}.` : "Add the Instagram username so the planner and design studio can publish to this business."}</span>
    </div>
    <button type="button" className="refresh-button" disabled={busy !== "" || (authRequired && !adminToken)} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save brand kit"}</button>
  </section>;
}
