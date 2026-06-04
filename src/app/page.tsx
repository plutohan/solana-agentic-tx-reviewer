"use client";

import { useState } from "react";
import type { Cluster, ReviewResult } from "@/lib/types";
import { ResultView } from "@/components/ResultView";

export default function Home() {
  const [signature, setSignature] = useState("");
  const [cluster, setCluster] = useState<Cluster>("mainnet-beta");
  const [rpcUrl, setRpcUrl] = useState("");
  const [showRpc, setShowRpc] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signature: signature.trim(),
          cluster,
          rpcUrl: rpcUrl.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Request failed");
      } else {
        setResult(data as ReviewResult);
      }
    } catch (err) {
      setError((err as Error).message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
          Solana Agentic Transaction Reviewer
        </h1>
        <p className="mt-1.5 text-sm text-zinc-400">
          Paste a transaction signature for a human-readable explanation and a
          deterministic risk report. Read-only — nothing is signed or sent.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
      >
        <input
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          placeholder="Transaction signature (base58)…"
          spellCheck={false}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
        />
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={cluster}
            onChange={(e) => setCluster(e.target.value as Cluster)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500"
          >
            <option value="mainnet-beta">mainnet-beta</option>
            <option value="devnet">devnet</option>
            <option value="testnet">testnet</option>
          </select>
          <button
            type="button"
            onClick={() => setShowRpc((v) => !v)}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            {showRpc ? "− hide RPC override" : "+ custom RPC"}
          </button>
          <button
            type="submit"
            disabled={loading || !signature.trim()}
            className="ml-auto rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "Reviewing…" : "Review"}
          </button>
        </div>
        {showRpc && (
          <input
            value={rpcUrl}
            onChange={(e) => setRpcUrl(e.target.value)}
            placeholder="https://your-rpc-endpoint  (optional, avoids public-RPC rate limits)"
            spellCheck={false}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
          />
        )}
      </form>

      {error && (
        <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-6">
          <div className="mb-2 flex justify-end">
            <a
              href={`/tx/${encodeURIComponent(result.request.signature)}?cluster=${result.request.cluster ?? "mainnet-beta"}`}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Open shareable permalink ↗
            </a>
          </div>
          <ResultView result={result} />
        </div>
      )}

      {!result && !error && !loading && (
        <p className="mt-6 text-center text-xs text-zinc-600">
          Tip: copy a signature from Solscan or your wallet history. Public RPC
          endpoints rate-limit and prune old transactions — use a custom RPC for
          reliable results.
        </p>
      )}
    </main>
  );
}
