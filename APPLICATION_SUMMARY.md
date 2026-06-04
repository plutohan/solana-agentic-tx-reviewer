# Solana Agentic Transaction Reviewer

**The review step an agent runs before it signs: a read-only tool that turns a raw Solana transaction into a plain-English explanation and a scored, auditable risk report, so a human (or an agent) understands what was signed or is about to be.**

> Status: working proof-of-concept. Submitted for the Superteam Agentic Engineering micro-grant (~200 USDG, Solana Earn).

---

## 1. Agentic engineering, two ways at once

This project leads with the grant theme, agentic engineering, in both directions.

**Built *with* agents.** A multi-agent workflow scaffolded, documented, and adversarially reviewed the codebase. A research-agent discovery pass confirmed the on-chain program IDs in the registry. An adversarial-review pass de-risked the heuristics. It found a false-positive where a routine Jupiter swap read HIGH "fully drained" off a pool account, and we killed it. Agents brought the toolchain current (Node 24, Rust 1.96, Agave 4.0.1, Anchor 1.0.2) and wrote the regression suite that now guards every change. The build process is the demo. This is what agent-assisted engineering produces when you hold it to a verifiable bar.

**Built to *become* an agent.** Think of the reviewer as the review step in the agent loop. An agent proposes a transaction, the reviewer judges it (`parse → heuristics → explanation`), and a human or higher-level agent approves. An autonomous signer that can *act* without a structured, grounded way to *review* is a liability. That review step is the safety primitive Solana's agentic future is missing. The clean `fetch → parse() → assessRisk() → explainTransaction()` contract, exposed as a single `reviewTransaction()` call, is exactly the tool an agent needs to reason about a transaction with facts instead of hallucinations.

## 2. The problem: signing blind

Every day, Solana users and bots approve transactions they cannot read. Wallets render base58 keys you can't make sense of and a "confirm" button. Explorers render instruction data, account indexes, and CPI trees, but not "this hands control of your token account to a stranger." That gap is where drains live. Delegate approvals, `SetAuthority` handovers, and full token-account sweeps look normal in an explorer and are devastating in practice. The information is on-chain and public. It just isn't *explained*. As agents start holding keys, the gap scales with them.

## 3. What's built

A complete, runnable Next.js 16 (App Router) app. It is **read-only**. It never signs, never sends, never holds a key. You paste a signature. It fetches over Solana RPC (`getParsedTransaction`, `maxSupportedTransactionVersion: 0`), normalizes the result (SOL deltas, SPL token balance changes, flattened top-level **and** inner/CPI instructions, aggregated program invocations), runs deterministic heuristics, and produces a natural-language explanation plus a scored risk report. In `src/lib/`: `types.ts`, `solana.ts` (read-only RPC plus an SSRF guard on client-supplied URLs), `parse.ts`, `programs.ts`, `heuristics.ts`, `watchlist.ts`, `ai.ts`, and `review.ts`, orchestrated behind `src/app/api/review/route.ts`.

**Tuned, signer-scoped, swap-aware heuristics (18 rules, up from 16).** I hardened the engine in `heuristics.ts` against the false positives that plague naive scanners:

- **Signer-scoped drains.** `FULL_TOKEN_ACCOUNT_DRAIN` and `LARGE_TOKEN_OUTFLOW` now fire **only on signer-owned token accounts**. Pool/vault accounts (owned by program PDAs) routinely zero out during a swap, so we ignore them. That was the single biggest source of false alarms.
- **Wrapped SOL excluded.** `So111…112` (WSOL) is transient by design. The native-SOL rules already cover it, so it no longer trips token-drain logic.
- **New `TOKEN_SWAP` rule (low).** When a would-be drain coincides with the **same signer receiving value back** (a different-mint token inflow above one base unit, or net SOL) **and** a known DEX program is present, we *relabel* the finding a swap rather than clear it. Dusted fake inflows and undefined owners fail safe to the higher-risk finding. Known venues (`isDexProgram`) include Jupiter v4/v6, Raydium v4/CLMM/CPMM, Orca Whirlpools, Meteora DLMM/DAMM v2, Phoenix, Lifinity v2, PumpSwap AMM, and pump.fun.
- **New `FLAGGED_ADDRESS` rule** backed by `watchlist.ts`, a curated, **best-effort, non-exhaustive, not-financial-advice** list. I seeded it honestly with the known SOL burn/incinerator address (program-ID matching is wired but empty by default to avoid false accusations).
- **De-saturated scoring.** `assessRisk()` dedups same-id findings (merging evidence, tagging `×N`) and applies **diminishing returns** (`weight × 0.5^k` for the *k*-th finding at a level). Level weights are unchanged (`info 0 / low 10 / medium 25 / high 45`). The result: a routine swap reads LOW while a real, *stacked* drainer stays HIGH.

Every finding carries human-readable evidence. These are explainable **signals, not verdicts**.

**A real, dual-provider LLM behind a free-by-default seam.** `ai.ts` genuinely calls **Anthropic or OpenAI** (selected by `AI_PROVIDER`, with `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` or `OPENAI_API_KEY`/`OPENAI_MODEL`). The Anthropic path uses prompt caching on the static system prompt. With no key set, it returns a deterministic, template-based placeholder. **Zero keys, zero cost, always works.** **Any** error (missing key, network, rate limit, bad JSON) degrades gracefully to that placeholder. Configure a key and the "agentic" claim is substantiated. Skip it and the PoC stays honest and self-contained.

**A shareable permalink with an OG risk card.** `GET /tx/<signature>?cluster=…` (`src/app/tx/[signature]/page.tsx`) server-renders the full `reviewTransaction` pipeline, reusing `ResultView` with zero new risk logic. A Next 16 `ImageResponse` OG card (`opengraph-image.tsx`) shows risk level plus score plus a short signature, so a pasted link unfurls into a risk preview (`metadataBase` comes from `NEXT_PUBLIC_SITE_URL`). The home page links straight to it via "Open shareable permalink."

**A passing regression suite.** `npm test` runs `tests/heuristics.test.ts` via `tsx`. That is 10 deterministic checks proving: a sell-via-DEX becomes `TOKEN_SWAP` (not HIGH, score < 25); a real drain is HIGH (score ≥ 45); pool and WSOL noise is filtered; the watchlist fires. All pass. The project is now a git repo with a baseline and enhancement history.

**Toolchain (current):** Node.js 24.16.0 LTS, Next.js 16.2.7, React 19.2.7, TypeScript 6, Tailwind CSS 4.3.0 (CSS-first), `@solana/web3.js` 1.98.4. Agents updated the broader machine toolchain (Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2), though this web app does not use it.

## 4. Roadmap: pre-sign simulation is the headline milestone

The next milestone makes the agent-loop framing literal: let an agent or user review an **unsigned** transaction before approving it. The recipe is de-risked. Accept a base64 unsigned `VersionedTransaction`, call `simulateTransaction({ sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: 'base64', addresses } })`, derive account deltas via `getMultipleAccountsInfo`, and run the **same** `parse → risk → explain` pipeline. No new risk logic. The safety layer simply moves before the signature. Full deliverables and sequencing live in **`MILESTONES.md`**.

## 5. The ask & honest caveats

A modest ~200 USDG to take this from a tuned PoC to a genuinely useful public tool: ship pre-sign simulation, expand the program registry and watchlist (only from citable sources), harden the client-supplied `rpcUrl` passthrough toward a production allowlist, and broaden LLM coverage.

**Stated plainly:** heuristics are best-effort signals, not guarantees. The watchlist is curated and non-exhaustive, not financial advice. Public RPC rate-limits and prunes old transactions (a custom RPC is supported). The `rpcUrl` passthrough ships with a baseline SSRF guard, but a production allowlist is still recommended. There is no persistence. Always verify on a trusted block explorer before acting.

## 6. Links & contact

- **Repository:** https://github.com/plutohan/solana-agentic-tx-reviewer (public)
- **Roadmap:** see `MILESTONES.md` in this repo.
- **Contact:** _<!-- CONTACT PLACEHOLDER: add name, email, X/Discord, and wallet for grant disbursement -->_

---

*This is a read-only proof-of-concept. It analyzes transactions, but it never signs or sends them. Risk heuristics and the watchlist are best-effort signals, not security guarantees or financial advice.*
