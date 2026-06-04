import type { ReactNode } from "react";
import type { RiskLevel } from "@/lib/types";

const STYLES: Record<RiskLevel, string> = {
  info: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  low: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  high: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function RiskBadge({
  level,
  children,
}: {
  level: RiskLevel;
  children?: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide ${STYLES[level]}`}
    >
      {children ?? level}
    </span>
  );
}
