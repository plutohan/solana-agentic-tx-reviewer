import type { ReactNode } from "react";
import type { ReviewResult } from "@/lib/types";
import { formatSol, formatTokenAmount, shortPubkey } from "@/lib/format";
import { RiskBadge } from "./RiskBadge";

function Card({
  title,
  children,
  right,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
          {title}
        </h2>
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
      {/* Overview */}
      <Card
        title="Overview"
        right={
          <div className="flex items-center gap-2">
            {tx.simulated && (
              <span className="rounded-full bg-violet-500/15 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-violet-300">
                Simulated
              </span>
            )}
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
          </div>
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
                  className="underline decoration-zinc-700 underline-offset-2 hover:decoration-zinc-400"
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

      {/* AI explanation */}
      <Card
        title="AI Explanation"
        right={
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
            {explanation.provider === "placeholder"
              ? "rule-based · LLM-ready"
              : explanation.provider}
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
                <span className="text-zinc-600">·</span>
                <span className="font-mono text-[13px]">{b}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 space-y-1 border-t border-zinc-800 pt-3">
          {explanation.caveats.map((c, i) => (
            <p key={i} className="text-xs text-zinc-500">
              {c}
            </p>
          ))}
        </div>
      </Card>

      {/* Risk report */}
      <Card
        title="Risk Report"
        right={
          <div className="flex items-center gap-2">
            <RiskBadge level={risk.level} />
            <span className="text-xs text-zinc-500">score {risk.score}/100</span>
          </div>
        }
      >
        <p className="mb-3 text-sm text-zinc-300">{risk.summary}</p>
        {risk.findings.length === 0 ? (
          <p className="text-sm text-zinc-500">No findings.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {risk.findings.map((f, i) => (
              <li
                key={`${f.id}-${i}`}
                className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
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
                    {f.evidence.map((e, i) => (
                      <li key={i} className="font-mono text-xs text-zinc-500">
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

      {/* Programs */}
      <Card title={`Programs (${tx.programsInvoked.length})`}>
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
        <Card title={`Token Balance Changes (${tx.tokenBalanceChanges.length})`}>
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
                  <tr key={c.accountIndex} className="border-t border-zinc-800">
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
      <Card title={`Instructions (${tx.instructions.length})`}>
        <ul className="flex flex-col gap-1">
          {tx.instructions.map((ix) => (
            <li
              key={ix.index}
              className={`flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm ${
                ix.isInner ? "ml-4 bg-zinc-950/40" : "bg-zinc-800/30"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="text-xs text-zinc-600">#{ix.index}</span>
                {ix.isInner && (
                  <span className="text-[10px] uppercase text-zinc-600">cpi</span>
                )}
                <span className="text-zinc-200">
                  {ix.programName ?? (
                    <span className="text-amber-300">{shortPubkey(ix.programId, 6)}</span>
                  )}
                </span>
                {ix.parsedType && (
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
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
      <Card title={`Accounts (${tx.accounts.length})`}>
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
                <tr key={a.index} className="border-t border-zinc-800">
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
                        <span className="rounded bg-zinc-700 px-1.5 text-xs text-zinc-300">
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
        <Card title={`Program Logs (${tx.logMessages.length})`}>
          <details>
            <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
              Show raw log messages
            </summary>
            <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-400">
              {tx.logMessages.join("\n")}
            </pre>
          </details>
        </Card>
      )}
    </div>
  );
}
