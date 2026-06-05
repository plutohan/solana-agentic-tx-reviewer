import type { ReactNode } from "react";
import type { ReviewResult } from "@/lib/types";
import { formatSol, formatTokenAmount, shortPubkey } from "@/lib/format";
import { RiskBadge } from "./RiskBadge";
import { RiskGauge } from "./RiskGauge";

function Card({
  title,
  children,
  right,
  delay = 0,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
  delay?: number;
}) {
  return (
    <section
      className="enter rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-3 w-[2px] rounded-full bg-accent/60" />
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
            {title}
          </h2>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[13px] break-all text-zinc-200">
      {children}
    </span>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="text-sm text-zinc-200">{value}</span>
    </div>
  );
}

export function ResultView({ result }: { result: ReviewResult }) {
  const { transaction: tx, risk, explanation } = result;

  const explorerUrl =
    tx.cluster === "mainnet-beta"
      ? `https://solscan.io/tx/${tx.signature}`
      : `https://solscan.io/tx/${tx.signature}?cluster=${tx.cluster}`;

  return (
    <div className="flex flex-col gap-4">
      {/* Risk report (hero) */}
      <Card
        title="Risk Report"
        delay={0}
        right={
          tx.simulated ? (
            <span className="rounded-full bg-cyan-500/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
              Simulated · pre-sign
            </span>
          ) : undefined
        }
      >
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-7">
          <RiskGauge score={risk.score} level={risk.level} />
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <div className="flex items-center justify-center gap-2 sm:justify-start">
              <RiskBadge level={risk.level} />
              <span className="text-xs text-zinc-500">overall risk</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-300">
              {risk.summary}
            </p>
          </div>
        </div>

        {risk.findings.length > 0 && (
          <ul className="mt-5 flex flex-col gap-2 border-t border-white/[0.06] pt-5">
            {risk.findings.map((f, i) => (
              <li
                key={`${f.id}-${i}`}
                className="rounded-xl border border-white/[0.06] bg-black/30 p-3"
              >
                <div className="mb-1 flex items-center gap-2">
                  <RiskBadge level={f.level} />
                  <span className="text-sm font-medium text-zinc-100">
                    {f.title}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">{f.detail}</p>
                {f.evidence && f.evidence.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {f.evidence.map((e, j) => (
                      <li key={j} className="font-mono text-xs text-zinc-500">
                        {e}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* AI explanation */}
      <Card
        title="AI Explanation"
        delay={80}
        right={
          <span className="rounded-full bg-black/40 px-2 py-0.5 text-xs text-zinc-400 ring-1 ring-white/5">
            {explanation.provider === "placeholder"
              ? "rule-based · LLM-ready"
              : `${explanation.provider}${explanation.model ? ` · ${explanation.model}` : ""}`}
          </span>
        }
      >
        <p className="text-sm leading-relaxed text-zinc-200">
          {explanation.summary}
        </p>
        {explanation.bullets.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1">
            {explanation.bullets.map((b, i) => (
              <li key={i} className="flex gap-2 text-sm text-zinc-300">
                <span className="text-accent/50">›</span>
                <span className="font-mono text-[13px]">{b}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 space-y-1 border-t border-white/[0.06] pt-3">
          {explanation.caveats.map((c, i) => (
            <p key={i} className="text-xs text-zinc-500">
              {c}
            </p>
          ))}
        </div>
      </Card>

      {/* Overview */}
      <Card
        title="Overview"
        delay={160}
        right={
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              tx.success
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-rose-500/15 text-rose-300"
            }`}
          >
            {tx.simulated
              ? tx.success
                ? "Would succeed"
                : "Would fail"
              : tx.success
                ? "Success"
                : "Failed"}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field
            label={tx.simulated ? "Source" : "Signature"}
            value={
              tx.simulated ? (
                "unsigned (pre-sign)"
              ) : (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-zinc-700 underline-offset-2 transition hover:decoration-accent/60"
                >
                  <Mono>{shortPubkey(tx.signature, 8)} ↗</Mono>
                </a>
              )
            }
          />
          <Field label="Cluster" value={tx.cluster} />
          <Field
            label="Slot"
            value={tx.simulated ? "—" : tx.slot.toLocaleString()}
          />
          <Field
            label="Block time"
            value={
              tx.blockTime
                ? new Date(tx.blockTime * 1000).toLocaleString()
                : "—"
            }
          />
          <Field
            label={tx.simulated ? "Fee (est.)" : "Fee"}
            value={
              tx.simulated && tx.feeLamports === 0
                ? "—"
                : `${formatSol(tx.feeSol)} SOL`
            }
          />
          <Field
            label="Compute units"
            value={tx.computeUnitsConsumed?.toLocaleString() ?? "—"}
          />
          <Field label="Fee payer" value={<Mono>{shortPubkey(tx.feePayer, 6)}</Mono>} />
          <Field label="Signers" value={tx.signers.length} />
          <Field label="Writable accts" value={tx.writableAccounts.length} />
        </div>
      </Card>

      {/* Programs */}
      <Card title={`Programs (${tx.programsInvoked.length})`} delay={220}>
        <ul className="flex flex-col gap-1.5">
          {tx.programsInvoked.map((p) => (
            <li
              key={p.programId}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="text-zinc-200">
                {p.name ?? <span className="text-amber-300">Unknown program</span>}
              </span>
              <span className="flex items-center gap-3">
                <Mono>{shortPubkey(p.programId, 6)}</Mono>
                <span className="text-xs text-zinc-500">×{p.count}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* Token balance changes */}
      {tx.tokenBalanceChanges.length > 0 && (
        <Card title={`Token Balance Changes (${tx.tokenBalanceChanges.length})`} delay={280}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="pb-2 font-medium">Owner</th>
                  <th className="pb-2 font-medium">Token</th>
                  <th className="pb-2 text-right font-medium">Before</th>
                  <th className="pb-2 text-right font-medium">After</th>
                  <th className="pb-2 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[13px]">
                {tx.tokenBalanceChanges.map((c) => (
                  <tr key={c.accountIndex} className="border-t border-white/[0.06]">
                    <td className="py-1.5 text-zinc-300">
                      {shortPubkey(c.owner ?? c.account)}
                    </td>
                    <td className="py-1.5">
                      {c.symbol ? (
                        <span className="text-zinc-200">
                          {c.symbol}
                          <span className="ml-1.5 text-[11px] text-zinc-600">
                            {shortPubkey(c.mint, 4)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-zinc-400">{shortPubkey(c.mint)}</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right text-zinc-400">
                      {formatTokenAmount(c.uiPreAmount, c.decimals)}
                    </td>
                    <td className="py-1.5 text-right text-zinc-400">
                      {formatTokenAmount(c.uiPostAmount, c.decimals)}
                    </td>
                    <td
                      className={`py-1.5 text-right ${
                        c.delta >= 0 ? "text-emerald-300" : "text-rose-300"
                      }`}
                    >
                      {c.delta >= 0 ? "+" : ""}
                      {formatTokenAmount(c.delta, c.decimals)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Instructions */}
      <Card title={`Instructions (${tx.instructions.length})`} delay={340}>
        <ul className="flex flex-col gap-1">
          {tx.instructions.map((ix) => (
            <li
              key={ix.index}
              className={`flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-sm ${
                ix.isInner
                  ? "ml-4 border-l border-white/[0.06] bg-black/20"
                  : "bg-white/[0.03]"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs text-zinc-600">#{ix.index}</span>
                {ix.isInner && (
                  <span className="text-[10px] uppercase tracking-wide text-accent/50">
                    cpi
                  </span>
                )}
                <span className="text-zinc-200">
                  {ix.programName ?? (
                    <span className="text-amber-300">{shortPubkey(ix.programId, 6)}</span>
                  )}
                </span>
                {ix.parsedType && (
                  <span className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs text-zinc-400 ring-1 ring-white/5">
                    {ix.parsedType}
                  </span>
                )}
              </span>
              <span className="text-xs text-zinc-600">
                {ix.accounts.length} accts
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* Accounts */}
      <Card title={`Accounts (${tx.accounts.length})`} delay={400}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="pb-2 font-medium">#</th>
                <th className="pb-2 font-medium">Address</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 text-right font-medium">SOL Δ</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[13px]">
              {tx.accounts.map((a) => (
                <tr key={a.index} className="border-t border-white/[0.06]">
                  <td className="py-1.5 text-zinc-600">{a.index}</td>
                  <td className="py-1.5 text-zinc-300">{shortPubkey(a.pubkey, 6)}</td>
                  <td className="py-1.5">
                    <span className="flex gap-1">
                      {a.signer && (
                        <span className="rounded bg-sky-500/15 px-1.5 text-xs text-sky-300">
                          signer
                        </span>
                      )}
                      {a.writable && (
                        <span className="rounded bg-amber-500/15 px-1.5 text-xs text-amber-300">
                          writable
                        </span>
                      )}
                      {a.isProgram && (
                        <span className="rounded bg-zinc-700/60 px-1.5 text-xs text-zinc-300">
                          program
                        </span>
                      )}
                    </span>
                  </td>
                  <td
                    className={`py-1.5 text-right ${
                      a.solChangeLamports > 0
                        ? "text-emerald-300"
                        : a.solChangeLamports < 0
                          ? "text-rose-300"
                          : "text-zinc-600"
                    }`}
                  >
                    {a.solChangeLamports !== 0
                      ? `${a.solChangeSol >= 0 ? "+" : ""}${formatSol(a.solChangeSol)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Logs */}
      {tx.logMessages.length > 0 && (
        <Card title={`Program Logs (${tx.logMessages.length})`} delay={460}>
          <details>
            <summary className="cursor-pointer text-xs text-zinc-500 transition hover:text-zinc-300">
              Show raw log messages
            </summary>
            <pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-black/50 p-3 font-mono text-xs leading-relaxed text-zinc-400 ring-1 ring-white/5">
              {tx.logMessages.join("\n")}
            </pre>
          </details>
        </Card>
      )}
    </div>
  );
}
