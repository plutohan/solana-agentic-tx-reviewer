import type { Metadata } from "next";
import { reviewTransaction, ReviewError } from "@/lib/review";
import type { Cluster } from "@/lib/types";
import { ResultView } from "@/components/ResultView";
import { RiskBadge } from "@/components/RiskBadge";
import { shortPubkey } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Params = { signature: string };
type Search = { cluster?: string };

function resolveCluster(c?: string): Cluster {
  return c === "devnet" || c === "testnet" ? c : "mainnet-beta";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { signature } = await params;
  const sig = decodeURIComponent(signature);
  return {
    title: `Review ${shortPubkey(sig, 6)} — Solana Agentic Transaction Reviewer`,
    description:
      "Human-readable explanation and a deterministic risk report for a Solana transaction.",
  };
}

export default async function TxPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { signature } = await params;
  const { cluster } = await searchParams;
  const sig = decodeURIComponent(signature);

  let result = null;
  let error: string | null = null;
  try {
    result = await reviewTransaction({
      signature: sig,
      cluster: resolveCluster(cluster),
    });
  } catch (e) {
    error = e instanceof ReviewError ? e.message : (e as Error).message;
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <header className="mb-8 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
            ← Review another
          </a>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-zinc-100">
            Transaction Review
          </h1>
          <p className="mt-1 break-all font-mono text-xs text-zinc-500">{sig}</p>
        </div>
        {result && (
          <RiskBadge level={result.risk.level}>
            {result.risk.level} · {result.risk.score}
          </RiskBadge>
        )}
      </header>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {result && <ResultView result={result} />}
    </main>
  );
}
