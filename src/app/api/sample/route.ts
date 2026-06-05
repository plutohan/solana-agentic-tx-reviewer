/**
 * GET /api/sample?mode=signature|unsigned&cluster=...
 * Returns a ready-to-review sample so the demo always has valid input.
 */
import { NextResponse } from "next/server";
import { sampleSignature, sampleUnsignedTransaction } from "@/lib/sample";
import type { Cluster } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "unsigned" ? "unsigned" : "signature";
  const clusterParam = url.searchParams.get("cluster");
  const cluster: Cluster =
    clusterParam === "devnet" || clusterParam === "testnet"
      ? clusterParam
      : "mainnet-beta";

  try {
    if (mode === "unsigned") {
      const rawTransaction = await sampleUnsignedTransaction(cluster);
      return NextResponse.json({ rawTransaction });
    }
    const signature = await sampleSignature(cluster);
    return NextResponse.json({ signature });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
