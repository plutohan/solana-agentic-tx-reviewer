import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Mark";
import { RiskBadge } from "@/components/RiskBadge";
import { INCIDENTS, type Incident } from "@/lib/incidents";
import type { RiskLevel } from "@/lib/types";

export const metadata: Metadata = {
  title: "Real incidents, reviewed - Solana Agentic Transaction Reviewer",
  description:
    "Real, documented Solana drains run through the live reviewer. Reproducible verdicts on the exact on-chain transactions, including an honest case it does not catch.",
};

const DOT: Record<RiskLevel, string> = {
  info: "bg-sky-400",
  low: "bg-emerald-400",
  medium: "bg-amber-400",
  high: "bg-rose-400",
};

function shortSig(sig: string) {
  return `${sig.slice(0, 8)}...${sig.slice(-8)}`;
}

function IncidentCard({ incident: i, index }: { incident: Incident; index: number }) {
  return (
    <article
      className="enter rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] sm:p-5"
      style={{ animationDelay: `${60 + index * 50}ms` }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-sans text-base font-semibold text-zinc-100">{i.name}</h3>
          <p className="mt-1 text-xs text-zinc-500">
            <span className="text-zinc-300">{i.loss}</span> lost · {i.date} ·{" "}
            <a
              href={i.source.url}
              target="_blank"
              rel="noreferrer"
              className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 transition hover:text-accent"
            >
              {i.source.label} ↗
            </a>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RiskBadge level={i.level} />
          <span className="font-mono text-xs text-zinc-500">{i.score}/100</span>
        </div>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-zinc-400">{i.mechanism}</p>

      <ul className="mt-3 flex flex-col gap-1.5">
        {i.findings.map((f) => (
          <li key={f.id} className="flex items-center gap-2 text-xs">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[f.level]}`} />
            <span className="font-mono text-[11px] text-zinc-500">{f.id}</span>
            <span className="text-zinc-400">{f.title}</span>
          </li>
        ))}
      </ul>

      <div
        className={`mt-4 rounded-xl border px-3.5 py-3 text-sm leading-relaxed ${
          i.outcome === "caught"
            ? "border-accent/20 bg-accent/[0.06] text-zinc-300"
            : "border-amber-500/20 bg-amber-500/[0.05] text-zinc-300"
        }`}
      >
        <span
          className={`mr-1.5 font-semibold ${
            i.outcome === "caught" ? "text-accent" : "text-amber-300"
          }`}
        >
          {i.outcome === "caught" ? "Caught:" : "Honest limit:"}
        </span>
        {i.verdict}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-zinc-600">{shortSig(i.signature)}</span>
        <Link
          href={`/tx/${encodeURIComponent(i.signature)}?cluster=mainnet-beta`}
          className="text-xs text-accent/80 transition hover:text-accent"
        >
          Verify live ↗
        </Link>
      </div>
    </article>
  );
}

export default function IncidentsPage() {
  const caught = INCIDENTS.filter((i) => i.outcome === "caught");
  const limits = INCIDENTS.filter((i) => i.outcome === "limitation");

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <header className="enter mb-8">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Mark size={26} />
          <h1 className="font-sans text-lg font-bold tracking-tight text-zinc-50">
            Real incidents, reviewed
          </h1>
          <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-accent">
            reproducible
          </span>
        </div>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
          Documented, real Solana drains run through the live reviewer. Every verdict below
          is the engine&apos;s actual output on that exact on-chain transaction. Click{" "}
          <span className="text-zinc-200">Verify live</span> to reproduce it, or call the
          public API on the same signature. Simulation is not enough; static
          instruction-level review catches what a balance-diff preview misses, and it is
          honest about what it does not catch.
        </p>
        <Link
          href="/"
          className="mt-3 inline-block text-xs text-zinc-500 transition hover:text-accent"
        >
          ← review your own transaction
        </Link>
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.15em] text-zinc-500">
          Caught before signing
        </h2>
        <div className="flex flex-col gap-4">
          {caught.map((i, idx) => (
            <IncidentCard key={i.slug} incident={i} index={idx} />
          ))}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.15em] text-zinc-500">
          Where static review does not help (honest)
        </h2>
        <div className="flex flex-col gap-4">
          {limits.map((i, idx) => (
            <IncidentCard key={i.slug} incident={i} index={caught.length + idx} />
          ))}
        </div>
      </section>

      <footer className="enter border-t border-white/[0.06] pt-5 text-xs leading-relaxed text-zinc-500">
        Read-only. The reviewer never signs or sends. These are confirmed historical
        transactions; the verdicts come from the deterministic engine
        (<span className="font-mono text-zinc-400">assessRisk</span> +{" "}
        <span className="font-mono text-zinc-400">decide</span>), not from an LLM. Reproduce
        any of them with the public API:{" "}
        <span className="font-mono text-zinc-400">POST /api/v1/review</span>.
      </footer>
    </main>
  );
}
