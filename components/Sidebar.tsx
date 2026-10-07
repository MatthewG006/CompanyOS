import Link from "next/link";

const links = [
  ["Overview", "/"],
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
  return <aside className="sidebar">
    <div className="brand-block"><div className="brand-mark">SM</div><div><div className="brand-name">Sky Mountain</div><div className="brand-sub">CompanyOS</div></div></div>
    <nav>{links.map(([label, href]) => <Link key={href} href={href} className="nav-link">{label}</Link>)}</nav>
    <div className="sidebar-footer"><div className="system-state"><span className="status-dot good" /> Command Center online</div><div className="system-note">Business automation · v0.6</div>{ownerAuthEnabled ? <form action="/api/auth/logout" method="post"><button className="signout-button" type="submit">Sign out</button></form> : null}</div>
  </aside>;
}
