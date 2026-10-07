type Props = { status: string };

export function StatusDot({ status }: Props) {
  const normalized = status.toLowerCase();
  const tone = normalized.includes("healthy") || normalized === "active" || normalized === "working" || normalized === "info"
    ? "good"
    : normalized.includes("warning") || normalized === "building" || normalized === "pending"
      ? "warn"
      : normalized.includes("critical") || normalized.includes("error") || normalized === "failed"
        ? "bad"
        : "neutral";
  return <span className={`status-dot ${tone}`} role="status" aria-label={status} title={status} />;
}
