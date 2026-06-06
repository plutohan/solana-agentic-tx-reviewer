"use client";

import { useState } from "react";
import type { Cluster, ReviewResult } from "@/lib/types";
import { ResultView } from "@/components/ResultView";
import { Mark } from "@/components/Mark";

type Mode = "signature" | "unsigned";

export default function Home() {
  const [mode, setMode] = useState<Mode>("signature");
  const [signature, setSignature] = useState("");
  const [rawTx, setRawTx] = useState("");
  const [cluster, setCluster] = useState<Cluster>("mainnet-beta");
  const [rpcUrl, setRpcUrl] = useState("");
  const [showRpc, setShowRpc] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);

  const canSubmit =
    !loading && (mode === "signature" ? signature.trim() : rawTx.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const body =
        mode === "unsigned"
          ? { rawTransaction: rawTx.trim(), cluster, rpcUrl: rpcUrl.trim() || undefined }
          : { signature: signature.trim(), cluster, rpcUrl: rpcUrl.trim() || undefined };
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  async function loadSample() {
    setSampling(true);
    setError(null);
    try {
      const res = await fetch(`/api/sample?mode=${mode}&cluster=${cluster}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not load a sample");
      } else if (mode === "unsigned") {
        setRawTx(data.rawTransaction);
      } else {
        setSignature(data.signature);
      }
    } catch (err) {
      setError((err as Error).message ?? "Could not load a sample");
    } finally {
      setSampling(false);
    }
  }

  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={`rounded-lg px-3 py-1.5 text-sm transition ${
        mode === m
          ? "bg-accent/15 font-medium text-accent ring-1 ring-inset ring-accent/30"
          : "text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <header className="enter mb-9">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Mark size={28} />
          <h1 className="font-sans text-lg font-bold tracking-tight text-zinc-50">
            Solana Agentic Transaction Reviewer
          </h1>
          <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-accent">
            read-only
          </span>
        </div>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
          A plain-English explanation and a deterministic risk report for any Solana
          transaction. Paste a confirmed signature, or an unsigned transaction to
          review <span className="text-zinc-200">before you sign</span>. Nothing is
          ever signed or sent.
        </p>
        <a
          href="/incidents"
          className="mt-3 inline-block text-xs text-accent/80 transition hover:text-accent"
        >
          See it run on real drains: SlowMist, PYTH poisoning, Drift →
        </a>
      </header>

      <form
        onSubmit={handleSubmit}
        className="enter flex flex-col gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] sm:p-5"
        style={{ animationDelay: "60ms" }}
      >
        <div className="flex w-fit gap-1 rounded-xl bg-black/40 p-1 ring-1 ring-white/5">
          {tab("signature", "Confirmed signature")}
          {tab("unsigned", "Unsigned tx · pre-sign")}
        </div>

        {mode === "signature" ? (
          <input
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder="Transaction signature (base58)…"
            spellCheck={false}
            className="w-full rounded-xl border border-white/[0.08] bg-black/40 px-3.5 py-3 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <textarea
              value={rawTx}
              onChange={(e) => setRawTx(e.target.value)}
              placeholder="Base64-serialized UNSIGNED transaction…"
              spellCheck={false}
              rows={4}
              className="w-full resize-y rounded-xl border border-white/[0.08] bg-black/40 px-3.5 py-3 font-mono text-xs text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
            />
            <p className="text-xs text-zinc-500">
              Simulated read-only. A custom RPC is recommended (public RPC
              rate-limits simulation).
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <select
            value={cluster}
            onChange={(e) => setCluster(e.target.value as Cluster)}
            className="rounded-lg border border-white/[0.08] bg-black/40 px-3 py-2 text-sm text-zinc-200 outline-none transition focus:border-accent/50"
          >
            <option value="mainnet-beta">mainnet-beta</option>
            <option value="devnet">devnet</option>
            <option value="testnet">testnet</option>
          </select>
          <button
            type="button"
            onClick={loadSample}
            disabled={sampling}
            className="text-xs text-accent/80 transition hover:text-accent disabled:opacity-50"
          >
            {sampling ? "loading sample…" : "Load a sample"}
          </button>
          <button
            type="button"
            onClick={() => setShowRpc((v) => !v)}
            className="text-xs text-zinc-500 transition hover:text-zinc-300"
          >
            {showRpc ? "− hide RPC override" : "+ custom RPC"}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="ml-auto rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-zinc-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
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
            className="w-full rounded-xl border border-white/[0.08] bg-black/40 px-3.5 py-2 font-mono text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-accent/50"
          />
        )}
        {loading && <div className="scanning h-[3px] rounded-full" />}
      </form>

      {error && (
        <div className="enter mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-6">
          {result.request.signature && !result.transaction.simulated && (
            <div className="enter mb-2 flex justify-end">
              <a
                href={`/tx/${encodeURIComponent(result.request.signature)}?cluster=${result.request.cluster ?? "mainnet-beta"}`}
                className="text-xs text-zinc-500 transition hover:text-accent"
              >
                Open shareable permalink ↗
              </a>
            </div>
          )}
          <ResultView result={result} />
        </div>
      )}

      {!result && !error && !loading && (
        <div className="enter mt-12 flex flex-col items-center text-center" style={{ animationDelay: "140ms" }}>
          <Mark size={34} className="text-zinc-700" />
          <p className="mt-4 max-w-sm text-sm text-zinc-500">
            Paste a transaction, or click{" "}
            <span className="text-accent/80">Load a sample</span> to try one. Public
            RPC prunes old transactions, so a custom RPC is more reliable.
          </p>
        </div>
      )}
    </main>
  );
}
