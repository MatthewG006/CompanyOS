export default function Loading() {
  return (
    <div className="page-wrap" role="status" aria-label="Loading">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-line" />
      <div className="skeleton-grid">
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
      <div className="skeleton skeleton-panel" />
      <span className="skeleton-note">Loading…</span>
    </div>
  );
}
