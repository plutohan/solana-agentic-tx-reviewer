/**
 * POST /api/review
 * Body: { signature: string, cluster?: Cluster, rpcUrl?: string }
 * Returns: ReviewResult (200) | { error } (4xx/5xx)
 *
 * Runs on the Node.js runtime because @solana/web3.js needs Node APIs.
 */
import { NextResponse } from "next/server";
import { reviewTransaction, ReviewError } from "@/lib/review";
import type { Cluster } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { signature?: string; cluster?: Cluster; rpcUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await reviewTransaction({
      signature: body.signature ?? "",
      cluster: body.cluster,
      rpcUrl: body.rpcUrl,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ReviewError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: (e as Error).message ?? "Unexpected error" },
      { status: 500 },
    );
  }
}
