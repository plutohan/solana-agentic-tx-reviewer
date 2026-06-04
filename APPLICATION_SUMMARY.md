# Solana Agentic Transaction Reviewer

**The explainable safety-review step in the agent loop: a read-only tool that turns a raw Solana transaction into a plain-English explanation and a scored, auditable risk report — so a human, or an agent, understands what was signed (or is about to be).**

> Status: working proof-of-concept. Submitted for the Superteam Agentic Engineering micro-grant (~200 USDG, Solana Earn).

---

## 1. Agentic engineering, two ways at once

This project leads with the grant theme — agentic engineering — in both directions.

**Built *with* agents.** The codebase was scaffolded, documented, and adversarially reviewed by a multi-agent workflow. A research-agent discovery pass confirmed the on-chain program IDs in the registry; an adversarial-review pass de-risked the heuristics (it found, and we killed, a false-positive where a routine Jupiter swap read HIGH "fully drained" off a pool account). Agents brought the toolchain current — Node 24, Rust 1.96, Agave 4.0.1, Anchor 1.0.2 — and wrote the regression suite that now guards every change. The build process is the demo: this is what agent-assisted engineering produces when held to a verifiable bar.

**Built to *become* an agent.** Frame the reviewer as the explainable safety-review step in the agent loop: an agent proposes a transaction; the reviewer judges it (`parse → heuristics → explanation`); a human or higher-level agent approves. An autonomous signer that can *act* without a structured, grounded way to *review* is a liability — that review step is the missing safety primitive for Solana's agentic future. The clean `fetch → parse() → assessRisk() → explainTransaction()` contract, exposed as a single `reviewTransaction()` call, is exactly the tool an agent needs to reason about a transaction with facts instead of hallucinations.

## 2. The problem: signing blind

Every day, Solana users and bots approve transactions they cannot read. Wallets render opaque base58 keys and a "confirm" button; explorers render instruction data, account indexes, and CPI trees — not "this hands control of your token account to a stranger." That gap is where drains live: delegate approvals, `SetAuthority` handovers, and full token-account sweeps look normal in an explorer and are devastating in practice. The information is on-chain and public — it just isn't *explained*. As agents start holding keys, that gap becomes a machine-scale liability.

## 3. What's built

A complete, runnable Next.js 16 (App Router) app. It is **read-only**: it never signs, never sends, never holds a key. You paste a signature; it fetches over Solana RPC (`getParsedTransaction`, `maxSupportedTransactionVersion: 0`), normalizes the result (SOL deltas, SPL token balance changes, flattened top-level **and** inner/CPI instructions, aggregated program invocations), runs deterministic heuristics, and produces a natural-language explanation plus a scored risk report. In `src/lib/`: `types.ts`, `solana.ts` (read-only RPC + an SSRF guard on client-supplied URLs), `parse.ts`, `programs.ts`, `heuristics.ts`, `watchlist.ts`, `ai.ts`, and `review.ts`, orchestrated behind `src/app/api/review/route.ts`.

**Tuned, signer-scoped, swap-aware heuristics (18 rules, up from 16).** The engine in `heuristics.ts` was hardened against the false positives that plague naive scanners:

- **Signer-scoped drains.** `FULL_TOKEN_ACCOUNT_DRAIN` and `LARGE_TOKEN_OUTFLOW` now fire **only on signer-owned token accounts**. Pool/vault accounts (owned by program PDAs) routinely zero out during a swap and are ignored — the single biggest source of false alarms.
- **Wrapped SOL excluded.** `So111…112` (WSOL) is transient by design; the native-SOL rules cover it, so it no longer trips token-drain logic.
- **New `TOKEN_SWAP` rule (low).** When a would-be drain coincides with the **same signer receiving value back** (a different-mint token inflow above one base unit, or net SOL) **and** a known DEX program is present, the finding is defensively *relabeled* a swap rather than cleared. Dusted fake inflows and undefined owners fail safe to the higher-risk finding. Known venues (`isDexProgram`) include Jupiter v4/v6, Raydium v4/CLMM/CPMM, Orca Whirlpools, Meteora DLMM/DAMM v2, Phoenix, Lifinity v2, PumpSwap AMM, and pump.fun.
- **New `FLAGGED_ADDRESS` rule** backed by `watchlist.ts` — a curated, **best-effort, non-exhaustive, not-financial-advice** list, seeded honestly with the known SOL burn/incinerator address (program-ID matching is wired but empty by default to avoid false accusations).
- **De-saturated scoring.** `assessRisk()` dedups same-id findings (merging evidence, tagging `×N`) and applies **diminishing returns** (`weight × 0.5^k` for the *k*-th finding at a level). Level weights are unchanged (`info 0 / low 10 / medium 25 / high 45`). The result: a routine swap reads LOW while a real, *stacked* drainer stays HIGH.

Every finding carries human-readable evidence — these are explainable **signals, not verdicts**.

**A real, dual-provider LLM behind a free-by-default seam.** `ai.ts` genuinely calls **Anthropic or OpenAI** (selected by `AI_PROVIDER`, with `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` or `OPENAI_API_KEY`/`OPENAI_MODEL`); the Anthropic path uses prompt caching on the static system prompt. With no key set, it returns a deterministic, template-based placeholder — **zero keys, zero cost, always works** — and **any** error (missing key, network, rate limit, bad JSON) degrades gracefully to that placeholder. The "agentic" claim is substantiated the moment a key is configured, and the PoC stays honest and self-contained without one.

**A shareable permalink with an OG risk card.** `GET /tx/<signature>?cluster=…` (`src/app/tx/[signature]/page.tsx`) server-renders the full `reviewTransaction` pipeline, reusing `ResultView` with zero new risk logic. A Next 16 `ImageResponse` OG card (`opengraph-image.tsx`) shows risk level + score + a short signature, so a pasted link unfurls into a risk preview (`metadataBase` comes from `NEXT_PUBLIC_SITE_URL`). The home page links straight to it via "Open shareable permalink."

**A passing regression suite.** `npm test` runs `tests/heuristics.test.ts` via `tsx` — 10 deterministic checks proving: a sell-via-DEX becomes `TOKEN_SWAP` (not HIGH, score < 25); a real drain is HIGH (score ≥ 45); pool and WSOL noise is filtered; the watchlist fires. All pass. The project is now a git repo with a baseline and enhancement history.

**Toolchain (current):** Node.js 24.16.0 LTS, Next.js 16.2.7, React 19.2.7, TypeScript 6, Tailwind CSS 4.3.0 (CSS-first), `@solana/web3.js` 1.98.4. The broader machine toolchain (Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2) was updated by agents, though this web app does not use it.

## 4. Roadmap — headline milestone: pre-sign simulation

The next milestone makes the agent-loop framing literal: let an agent or user review an **unsigned** transaction before approving it. The recipe is de-risked — accept a base64 unsigned `VersionedTransaction`, call `simulateTransaction({ sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: 'base64', addresses } })`, derive account deltas via `getMultipleAccountsInfo`, and run the **same** `parse → risk → explain` pipeline. No new risk logic; the safety layer simply moves before the signature. Full deliverables and sequencing live in **`MILESTONES.md`**.

## 5. The ask & honest caveats

A modest ~200 USDG to take this from a tuned PoC to a genuinely useful public tool: ship pre-sign simulation, expand the program registry and watchlist (only from citable sources), harden the client-supplied `rpcUrl` passthrough toward a production allowlist, and broaden LLM coverage.

**Stated plainly:** heuristics are best-effort signals, not guarantees; the watchlist is curated and non-exhaustive, not financial advice; public RPC rate-limits and prunes old transactions (a custom RPC is supported); the `rpcUrl` passthrough ships with a baseline SSRF guard but a production allowlist is still recommended; there is no persistence. Always verify on a trusted block explorer before acting.

## 6. Links & contact

- **Repository:** local git repo at `/Users/pluto/dev/solana-agentic-tx-reviewer` _(public repo link: TODO — add before submission)_
- **Roadmap:** see `MILESTONES.md` in this repo.
- **Contact:** _<!-- CONTACT PLACEHOLDER: add name, email, X/Discord, and wallet for grant disbursement -->_

---

*This is a read-only proof-of-concept. It analyzes transactions; it never signs or sends them. Risk heuristics and the watchlist are best-effort signals, not security guarantees or financial advice.*
