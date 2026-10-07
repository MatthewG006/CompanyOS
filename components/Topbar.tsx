export function Topbar({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="topbar">
      <div>
        <div className="eyebrow">COMMAND CENTER</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="topbar-pill">OWNER VIEW</div>
    </header>
  );
}
