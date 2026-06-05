import type { RiskLevel } from "@/lib/types";

const LEVEL_COLOR: Record<RiskLevel, string> = {
  info: "#38bdf8",
  low: "#34d399",
  medium: "#fbbf24",
  high: "#fb7185",
};

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const [x1, y1] = polar(cx, cy, r, startDeg);
  const [x2, y2] = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** A 270-degree radial gauge for the 0-100 risk score, colored by level. */
export function RiskGauge({ score, level }: { score: number; level: RiskLevel }) {
  const cx = 100;
  const cy = 100;
  const r = 80;
  const START = 135;
  const SWEEP = 270;
  const clamped = Math.min(Math.max(score, 0), 100);
  const valueEnd = START + (SWEEP * clamped) / 100;
  const color = LEVEL_COLOR[level];

  return (
    <div className="relative h-40 w-40 shrink-0 sm:h-44 sm:w-44">
      <svg viewBox="0 0 200 200" className="h-full w-full">
        <path
          d={arc(cx, cy, r, START, START + SWEEP)}
          fill="none"
          stroke="rgba(255,255,255,0.07)"
          strokeWidth={11}
          strokeLinecap="round"
        />
        {clamped > 0 && (
          <path
            className="gauge-value"
            d={arc(cx, cy, r, START, valueEnd)}
            fill="none"
            stroke={color}
            strokeWidth={11}
            strokeLinecap="round"
            pathLength={1}
            style={{ filter: `drop-shadow(0 0 7px ${color}66)` }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div
          className="font-sans text-[2.75rem] font-extrabold leading-none tabular-nums"
          style={{ color }}
        >
          {clamped}
        </div>
        <div className="mt-0.5 text-[11px] text-zinc-500">/ 100</div>
        <div
          className="mt-2 text-[11px] font-semibold uppercase tracking-[0.22em]"
          style={{ color }}
        >
          {level}
        </div>
      </div>
    </div>
  );
}
