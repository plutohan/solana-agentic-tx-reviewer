import { ImageResponse } from "next/og";
import { reviewTransaction } from "@/lib/review";
import type { RiskLevel } from "@/lib/types";
import { shortPubkey } from "@/lib/format";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Solana transaction risk review";

const LEVEL_COLOR: Record<RiskLevel, string> = {
  info: "#38bdf8",
  low: "#34d399",
  medium: "#fbbf24",
  high: "#fb7185",
};

export default async function OgImage({
  params,
}: {
  params: Promise<{ signature: string }>;
}) {
  const { signature } = await params;
  const sig = decodeURIComponent(signature);

  let level: RiskLevel = "info";
  let score = 0;
  let line = "";
  try {
    const r = await reviewTransaction({ signature: sig });
    level = r.risk.level;
    score = r.risk.score;
    line = `${r.transaction.success ? "Success" : "Failed"} · ${r.transaction.programsInvoked.length} programs · ${r.transaction.tokenBalanceChanges.length} token changes`;
  } catch {
    line = "Transaction not found on this RPC";
  }

  const color = LEVEL_COLOR[level];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#09090b",
          color: "#f4f4f5",
          padding: "64px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 30, color: "#a1a1aa" }}>
            Solana Agentic Transaction Reviewer
          </div>
          <div
            style={{ marginTop: 16, fontSize: 40, color: "#e4e4e7", fontFamily: "monospace" }}
          >
            {shortPubkey(sig, 10)}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "28px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "20px 40px",
              borderRadius: 24,
              border: `4px solid ${color}`,
              color,
              fontSize: 72,
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            {level}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 64, fontWeight: 700 }}>{`${score}/100`}</div>
            <div style={{ fontSize: 26, color: "#a1a1aa" }}>risk score</div>
          </div>
        </div>

        <div style={{ display: "flex", fontSize: 26, color: "#71717a" }}>{line}</div>
      </div>
    ),
    size,
  );
}
