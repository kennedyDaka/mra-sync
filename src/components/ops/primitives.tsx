import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  SUBMITTED: "bg-success/15 text-success border-success/30",
  PENDING_SYNC: "bg-warning/15 text-warning border-warning/30",
  QUEUED: "bg-warning/15 text-warning border-warning/30",
  REJECTED: "bg-destructive/15 text-destructive border-destructive/30",
  FAILED: "bg-destructive/15 text-destructive border-destructive/30",
  active: "bg-success/15 text-success border-success/30",
  pending: "bg-warning/15 text-warning border-warning/30",
  error: "bg-destructive/15 text-destructive border-destructive/30",
  ACTIVE: "bg-success/15 text-success border-success/30",
  REVOKED: "bg-destructive/15 text-destructive border-destructive/30",
  EXPIRED: "bg-warning/15 text-warning border-warning/30",
};

export function StatusPill({ value }: { value: string | null | undefined }) {
  const label = value ?? "unknown";
  return (
    <span
      className={cn(
        "mono-tag inline-flex items-center rounded-full border px-2 py-0.5",
        TONE[label] ?? "bg-secondary text-secondary-foreground border-border",
      )}
    >
      {label}
    </span>
  );
}

export function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="panel p-4">
      <p className="mono-tag text-muted-foreground uppercase">{label}</p>
      <p className="mt-2 font-display text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
