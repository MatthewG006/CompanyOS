export function DemoBanner({ source }: { source: "database" | "demo" }) {
  if (source !== "demo") return null;
  return (
    <div className="demo-banner" role="alert">
      <strong>Demo data — PostgreSQL is unreachable.</strong> The projects, tasks, approvals and
      contacts shown are sample data, not your business data. Connect PostgreSQL to see live data.
    </div>
  );
}
