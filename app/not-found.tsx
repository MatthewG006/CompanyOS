import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page-wrap">
      <div className="panel state-panel">
        <h1>Page not found</h1>
        <p className="muted">That page does not exist in CompanyOS — the link may be outdated or the address mistyped.</p>
        <Link href="/" className="refresh-button state-link">Back to Overview</Link>
      </div>
    </div>
  );
}
