"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  ["Overview", "/"],
  ["Agency", "/agency"],
  ["Planner", "/planner"],
  ["Results", "/results"],
  ["Projects", "/projects"],
  ["AI Workforce", "/agents"],
  ["Sales", "/sales"],
  ["Onboarding", "/onboarding"],
  ["Support", "/support"],
  ["Operations", "/operations"],
  ["Finance", "/finance"],
  ["Communications", "/communications"],
  ["Intelligence", "/intelligence"],
  ["Settings", "/settings"],
] as const;

export function Sidebar({ ownerAuthEnabled = false }: { ownerAuthEnabled?: boolean }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  return <aside className="sidebar">
    <Link href="/" className="brand-block brand-link" aria-label="Sky Mountain CompanyOS — go to Overview">{/* biome-ignore lint/performance/noImgElement: static brand logo from /public, no optimization needed */}
      <img className="brand-logo" src="/brand-logo.png" alt="" width={38} height={38} /><div><div className="brand-name">Sky Mountain</div><div className="brand-sub">CompanyOS</div></div></Link>
    <nav>{links.map(([label, href]) => {
      const active = isActive(href);
      return <Link key={href} href={href} className={active ? "nav-link active" : "nav-link"} aria-current={active ? "page" : undefined}>{label}</Link>;
    })}</nav>
    <div className="sidebar-footer"><div className="system-state"><span className="status-dot good" /> Command Center online</div><div className="system-note">Business automation · v0.6</div>{ownerAuthEnabled ? <form action="/api/auth/logout" method="post"><button className="signout-button" type="submit">Sign out</button></form> : null}</div>
  </aside>;
}
