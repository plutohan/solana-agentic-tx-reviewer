import type { ReactNode } from "react";
import type { RiskLevel } from "@/lib/types";

const STYLES: Record<RiskLevel, string> = {
  info: "bg-sky-500/10 text-sky-300 border-sky-500/25",
  low: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25",
  medium: "bg-amber-500/10 text-amber-300 border-amber-500/25",
  high: "bg-rose-500/10 text-rose-300 border-rose-500/25",
};

const DOT: Record<RiskLevel, string> = {
  info: "bg-sky-400",
  low: "bg-emerald-400",
  medium: "bg-amber-400",
  high: "bg-rose-400",
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
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] ${STYLES[level]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[level]}`} />
      {children ?? level}
    </span>
  );
}
