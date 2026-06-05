# Milestones & Delivery Plan

**Project:** Solana Agentic Transaction Reviewer
**Grant:** Superteam Agentic Engineering micro-grant (~200 USDG, Solana Earn)
**Status:** Publicly deployed and live. Pre-sign simulation, token metadata, a real dual-provider LLM seam, a premium UI, a sample generator, and a 24-check test suite are all shipped. See [Current Status](#1-current-status-what-is-done-today).
**Live:** https://solana-agentic-tx-reviewer.vercel.app
**Scope discipline:** read-only analysis only. No new protocol. No signing or sending of transactions.

This is the delivery plan for the grant. It opens with the agentic-engineering framing (why this matters and how it was built), states plainly what exists today, then lays out an incremental roadmap with the remaining milestones. After that come a timeline, a budget mapping for a micro-grant, and a risk register. The headline work is built, verified, and deployed. The check that runs before a transaction gets signed is live in production, so it sits in Current Status rather than the roadmap.

A note on pace before the estimates below. The entire working reviewer in section 1, including the pre-sign path, the public deploy, and the redesign, was built across a single short working session, with agents doing most of the heavy lifting. That is the whole point of agentic engineering. It is why the milestones that follow are measured in days, not weeks.

---

## 0. Agentic-engineering framing (why this matters)

**Becoming an agent.** On Solana's road to autonomous, transaction-signing agents, the missing piece is judgment. Something has to read a transaction and say, in plain English, what it does and how risky it is, before anyone or anything approves it. This project is that step. The loop it slots into:

```
agent proposes a transaction → reviewer judges it (parse → heuristics → explanation) → human or agent approves
```

The reviewer is deterministic where it has to be. The risk score is a pure function of the on-chain facts. It is explainable everywhere else. Every finding carries human-readable evidence, and the natural-language layer is told to use only the provided facts. That makes the output safe to put in front of an automated approver. A swap reads LOW, a real drainer reads HIGH, and the reasoning is auditable. With the pre-sign path live in production, that same judgment runs on an unsigned transaction before it is approved, which is the moment that matters most.

**An under-crowded niche.** A Colosseum Copilot scan of 5,428 hackathon projects returned only 9 closely related projects, with a top similarity of just 5.5%, and none of them won a prize. The adjacent work is almost entirely consumer browser extensions. This reviewer is a server-side, deterministic, explainable safety layer aimed at the agent loop, not a wallet plugin. Detail and sources live in `grant-submission/colosseum-crowdedness.md`.

**Built with agents.** A multi-agent workflow scaffolded, tuned, adversarially reviewed, redesigned, and documented this codebase end-to-end across one working session. The agent session transcript is the proof.

- A research-agent discovery pass confirmed the program IDs now in the registry (PumpSwap, pump.fun Fee, Raydium CLMM/CPMM, Meteora DLMM/DAMM v2, Phoenix, Lifinity v2, Jupiter v4, Jito Tip) and de-risked the heuristics. The signer-scoping and swap-aware fixes below came straight out of that review.
- Agents updated the toolchain to current (Node 24.16.0, Rust 1.96.0, Agave 4.0.1, Anchor 1.0.2) and the web stack (Next 16, React 19, TS 6, Tailwind 4).
- The pre-sign-simulation recipe was de-risked the same way before any code was written. It was researched, sketched, reduced to a concrete RPC recipe, then built and verified live against mainnet (details in [section 1](#1-current-status-what-is-done-today)).
- A redesign agent took the UI from a plain form to the "forensic instrument" direction now in production. A deploy pass put it on Vercel.

---

## 1. Current Status: what is done today

A working Next.js (App Router) web app, deployed and live at https://solana-agentic-tx-reviewer.vercel.app. A user or an agent supplies either a confirmed transaction signature or a base64 unsigned transaction. The app either fetches the confirmed transaction read-only over Solana RPC, or simulates the unsigned one read-only, normalizes the result into a shared data model, runs deterministic risk heuristics, and renders a human-readable explanation plus a risk report. The same pipeline also backs a server-rendered shareable permalink for confirmed reviews.

The full pipeline is live end-to-end:

```
(RPC fetch | simulate) → parse() → enrich → assessRisk() → explainTransaction() → ReviewResult
(served by POST /api/review AND by GET /tx/<signature>)
```

The home page, confirmed-signature review, the pre-sign simulation path, the `/tx/<sig>` permalink, and the dynamic OpenGraph risk card all return 200 in production.

### What actually works

- **Pre-sign simulation** (`src/lib/presign.ts`): the headline feature, shipped and deployed. Review an unsigned transaction before approving it. The flow accepts a base64-serialized `VersionedTransaction`, deserializes it, resolves any address lookup tables (v0), then simulates read-only with `connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: "base64", addresses: writableAccounts } })`. It derives SOL and SPL token deltas by diffing the pre-state (`getMultipleAccountsInfo`) against the simulated post-state (token amount = u64 LE at byte 64, mint decimals from the mint account at byte 44). It recovers SPL Token and System instruction TYPES from the raw instruction data with a small discriminator decoder, so the same `parsedType`-dependent heuristics (setAuthority, approve, closeAccount, createAccount, and the rest) still fire. It estimates the fee via `getFeeForMessage`. It emits the SAME `ParsedTransaction` the confirmed path produces, with `simulated: true`, so the risk engine, the explanation, and the UI are unchanged. I verified this live. An unsigned transfer to the burn/incinerator address simulated successfully, showed SOL deltas of -0.001005 (the payer, fee included) and +0.001 (the burn), and the `FLAGGED_ADDRESS` watchlist rule fired before anything was signed. Nothing is ever signed or sent. Simulation only.
- **Token metadata enrichment** (`src/lib/metadata.ts`): shipped. Resolves a mint to `{ symbol, name, logoURI }` via a small known-token registry (SOL/USDC/USDT/BONK/JUP/WIF/JTO) plus a cached, best-effort Jupiter datapi lookup (`https://datapi.jup.ag/v1/assets/search?query=<mint>`), with graceful fallback to the raw mint when a token is unknown or the endpoint is unreachable. Token tables and the explanation now show "USDC" and a logo instead of a raw mint and a base-unit delta. `enrichTokenMetadata()` runs inside `reviewTransaction()` for BOTH paths and never throws.
- **Read-only RPC layer** (`src/lib/solana.ts`): the confirmed path only ever calls `getParsedTransaction` (with `maxSupportedTransactionVersion: 0`, `commitment: "confirmed"`), and the pre-sign path only ever simulates. There is no code path that signs or submits anything. `resolveRpcUrl()` picks an endpoint with the precedence `request.rpcUrl > SOLANA_RPC_URL (mainnet only) > public cluster default`. In production the server uses a Helius mainnet RPC. `isValidSignature()` does cheap base58 structural validation before any network call. `assertSafeRpcUrl()` is a baseline SSRF guard (http(s) only, with loopback/private/metadata hosts rejected) on any client-supplied URL.
- **Deterministic extraction** (`src/lib/parse.ts`): `parseTransaction(raw, signature, cluster)` normalizes the raw RPC response into the `ParsedTransaction` model. It computes per-account SOL deltas (post minus pre balances), SPL token balance changes (from `pre`/`postTokenBalances`, including each account's `owner`), flattens top-level AND inner (CPI) instructions into one list, and aggregates `programsInvoked` with counts. Everything downstream reads only this normalized shape. The pre-sign path builds the same shape from simulation output.
- **Shared data model / contract** (`src/lib/types.ts`): `ReviewRequest`, `AccountSummary`, `InstructionSummary`, `TokenBalanceChange`, `ProgramInvocation`, `ParsedTransaction`, `RiskLevel`, `RiskFinding`, `RiskReport`, `AiExplanation`, and `ReviewResult`. The UI, the API, the permalink, the risk engine, and the LLM all speak this one contract. `ReviewRequest` accepts `signature` OR `rawTransaction` (exactly one). The fields that backed the pre-sign and metadata work: `ReviewRequest.rawTransaction`, `ParsedTransaction.simulated`, and `TokenBalanceChange.symbol` / `name` / `logoURI`.
- **Program registry** (`src/lib/programs.ts`): a curated map of well-known program IDs to `{ name, category }`, covering System, SPL Token, SPL Token-2022, Associated Token Account, Compute Budget, Memo (v1 + current), BPF loaders, Stake, Vote, Metaplex Token Metadata, AND a research-confirmed DeFi set: Jupiter Aggregator v6 AND v4, Raydium AMM v4 / CLMM / CPMM, Orca Whirlpools, pump.fun (bonding curve) + pump.fun Fee, PumpSwap AMM, Meteora DLMM + DAMM v2, Phoenix, Lifinity v2, and Jito Tip Payment. Exposes `resolveProgram()`, `isKnownProgram()`, the `WSOL_MINT` constant, a `DEX_PROGRAM_IDS` set, and `isDexProgram()`.
- **Deterministic risk engine** (`src/lib/heuristics.ts`): **18** pure-function rules that emit explainable `RiskFinding`s with evidence (`TOKEN_SWAP` and `FLAGGED_ADDRESS` included). Score and level aggregation are deterministic (details in the [scoring](#risk-scoring-as-implemented-in-srclibheuristicsts) section and rules table below). These are explicitly **signals, not a verdict**. The major tuning that shipped:
  - **Signer-scoped drain/outflow.** `FULL_TOKEN_ACCOUNT_DRAIN` and `LARGE_TOKEN_OUTFLOW` only fire on token accounts owned by a signer. Pool/vault accounts (owned by program PDAs) routinely zero out during a swap, so they are ignored. That killed the biggest false positive, where a routine Jupiter/PumpSwap swap read HIGH "fully drained" off a *pool* account.
  - **Wrapped SOL excluded.** WSOL (`So111…112`) is skipped by the token drain/outflow rules. It is transient (wrap/unwrap), and the native-SOL rules already cover it.
  - **`TOKEN_SWAP` (low).** Defensively relabels a would-be full-drain or large-outflow when the *same signer* received non-dust value back (a different-mint token inflow `> 1` base unit, or net SOL `> 0.001`) AND a known DEX program is present. That is consistent with a swap or position exit, not a drain. An undefined owner or a dusted fake inflow fails safe to the higher-risk drain finding.
  - **`FLAGGED_ADDRESS` (from `src/lib/watchlist.ts`).** A curated, **best-effort, non-exhaustive, not-financial-advice** watchlist. Seeded honestly with only the well-known SOL burn/incinerator address (`FLAGGED_ADDRESSES`). The same mechanism matches flagged program IDs (`FLAGGED_PROGRAMS`, intentionally empty to avoid false accusations). `lookupWatch()` is fully wired, so the list grows without code changes. This is the rule I watched fire during the live pre-sign test.
  - **Scoring de-saturation.** `assessRisk()` de-dupes same-id findings (`dedupeFindings`, merging evidence and tagging `×N`) and applies **diminishing returns** (the k-th finding at a level adds `weight * 0.5^k`, via `computeScore`). A routine busy swap reads LOW. A real, *stacked* drainer stays HIGH. `LEVEL_WEIGHT` is unchanged (`info 0 / low 10 / medium 25 / high 45`).
- **Real dual-provider LLM, wired and deployed** (`src/lib/ai.ts`): `explainTransaction(tx, risk)` genuinely calls **Anthropic (Claude) or OpenAI** behind the dual-provider seam, gated on `AI_PROVIDER` plus the matching key, and maps the model's JSON into the existing `AiExplanation` shape (no schema change). Anthropic requests apply **prompt caching** to the static system prompt (`cache_control: ephemeral`). The system prompt tells the model to use *only* the provided facts. It is mode-aware. A simulated transaction is framed as an unsigned, not-yet-executed transaction. In production `AI_PROVIDER=anthropic` and the key are configured, so this produces real Claude explanations as soon as the Anthropic account is funded. Be honest about the state here. The integration is wired and deployed. It activates when the Anthropic account has credits. Until then, and on **any** error (missing key, network, rate limit, bad JSON), it degrades gracefully to the **free, deterministic placeholder**, so the app always works and stays free by default. I am not claiming Claude output is live right now. The seam is.
  - Env: `AI_PROVIDER=anthropic|openai`, `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`), `OPENAI_API_KEY` / `OPENAI_MODEL` (default `gpt-4o-mini`).
  - A diagnostic route, `GET /api/ai-status`, reports which AI config is present without ever returning a key value, and `?test=1` does a minimal live ping so you can tell "AI_PROVIDER not set" from "key/model rejected".
- **Sample generator** (`src/lib/sample.ts`, `GET /api/sample`): a "Load a sample" button builds a fresh unsigned transaction (a 0.001 SOL transfer to the burn address that always simulates and always trips the watchlist) or fetches a recent successful signature from a busy program. The demo never lands on an empty box or a pruned input. Results link the signature out to Solscan.
- **Orchestration + API** (`src/lib/review.ts`, `src/app/api/review/route.ts`): `reviewTransaction(request)` runs the pipeline and throws a typed `ReviewError(status)` for clean HTTP mapping (400 invalid input, 404 not found, 502 RPC error, 500 unexpected). It routes on the input: a `rawTransaction` triggers the pre-sign path (`simulateAndReview`, whose `PresignError` maps to `ReviewError`), and a `signature` triggers the confirmed path. `POST /api/review` with `{ rawTransaction: <base64> }` runs the simulation. It runs on the Node.js runtime, since `@solana/web3.js` needs Node APIs. The review routes set `maxDuration = 30` so the multi-RPC pre-sign path does not hit the default serverless timeout.
- **Shareable permalink + OG card** (`src/app/tx/[signature]/page.tsx`, `src/app/tx/[signature]/opengraph-image.tsx`): `GET /tx/<signature>?cluster=…` server-renders the **full** `reviewTransaction` pipeline and reuses `ResultView` / `RiskBadge`, with **zero new risk logic**. A Next 16 `ImageResponse` OG card (risk level + score + short signature + a one-line summary) makes a pasted link unfurl into a risk preview. `metadataBase` auto-detects: `NEXT_PUBLIC_SITE_URL`, then `VERCEL_URL`, then `http://localhost:3000` (in `src/app/layout.tsx`). The home page surfaces an "Open shareable permalink ↗" link, shown only for confirmed reviews.
- **Premium UI** (`src/app/page.tsx`, `src/app/globals.css`, `src/components/*`): a "forensic instrument" redesign. Distinctive type (Bricolage Grotesque + JetBrains Mono via `next/font`, not system fonts), a single cyan accent, an atmospheric background (dot grid, soft glow, grain), and a radial **risk gauge** (`RiskGauge.tsx`, a 0-100 arc colored by level) as the hero of the risk report. A reticle wordmark (`Mark.tsx`), segmented input tabs ("Confirmed signature" / "Unsigned tx · pre-sign"), a cluster select, an optional custom RPC URL, and staggered card entrance motion that respects reduced-motion. `ResultView` renders the parsed transaction, risk findings, and explanation. It shows token symbols, plus a "SIMULATED" badge and "Would succeed / Would fail" on the pre-sign path.
- **Public Vercel deploy** (`DEPLOY.md`): the app is deployed and live on Vercel (Next.js 16, zero-config). RPC and LLM calls run server-side. No secrets ship to the browser. `DEPLOY.md` documents dashboard and CLI setup, the required `SOLANA_RPC_URL`, optional AI env, and a smoke-test checklist.
- **Tests** (`tests/heuristics.test.ts`, `tests/lib.test.ts`, run via `npm test`): **24** deterministic checks, all passing, with no live RPC. 10 over the risk engine: a DEX sell relabels to `TOKEN_SWAP` (not HIGH, score `< 25`), a genuine drain is `FULL_TOKEN_ACCOUNT_DRAIN` / HIGH / score `≥ 45`, a pool/vault (non-signer) zero-out is ignored, a signer WSOL outflow is ignored, and the burn-address watchlist fires. 14 over pure helpers: `rawToUi` (the base-unit to UI conversion) and `decodeIxType` (the pre-sign instruction decoder for SPL Token and System). `tsx` is a dev dependency. The pre-sign and metadata paths need a live RPC, so they were verified by live integration against mainnet rather than in the offline unit suite.
- **Git.** The project is a public git repository at https://github.com/plutohan/solana-agentic-tx-reviewer (a baseline commit plus the enhancement and deploy rounds).

### Toolchain (brought current as part of this project)

| Layer | Version |
| --- | --- |
| Node.js | 24.16.0 LTS |
| npm | 11.16.0 |
| Next.js (App Router) | 16.2.7 |
| React | 19.2.7 |
| TypeScript | 6.0.3 |
| Tailwind CSS | 4.3.0 (CSS-first: `@import "tailwindcss"` + `@tailwindcss/postcss`, with **no** `tailwind.config.js`) |
| `@solana/web3.js` | 1.98.4 (the v1 line. v2 lives on as `@solana/kit` 6.x, noted as a future option) |

The broader Solana dev toolchain on the machine is also current (Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2), though **none of these are used by this read-only web app**. The environment was simply brought up to date by agents, for completeness.

### Risk scoring (as implemented in `src/lib/heuristics.ts`)

- `LEVEL_WEIGHT`: `info = 0`, `low = 10`, `medium = 25`, `high = 45` (unchanged).
- **Score** = `clamp(sum, 0, 100)` where, per level, the k-th finding contributes `weight * 0.5^k`. These diminishing returns de-saturate busy-but-benign transactions while keeping stacked high-severity signals near the top.
- Same-id findings are **de-duplicated** first (evidence merged, title tagged `×N`).
- **Overall level** = the **maximum** individual finding level.
- `THRESHOLDS`: `largeSolOutflow = 1` SOL, `veryLargeSolOutflow = 10` SOL, `manyWritableAccounts = 12`, `highFeeSol = 0.01` SOL, `largeTokenOutflowPct = 0.5` (fraction of pre-balance). A `DUST_LAMPORTS = 0.001` SOL floor defines a "dust" inflow for the swap-aware check.

| Rule ID | Level | Trigger |
| --- | --- | --- |
| `TX_FAILED` | info | `meta.err != null` (transaction failed on-chain) |
| `FLAGGED_ADDRESS` | medium (burn) / high | an account or program matches the curated watchlist (`src/lib/watchlist.ts`) |
| `UNKNOWN_PROGRAM` | medium | invokes a program not in the registry |
| `LARGE_SOL_OUTFLOW` | medium (≥ 1 SOL) / high (≥ 10 SOL) | fee payer net SOL decrease |
| `TOKEN_SWAP` | low | signer-owned full-drain / large-outflow **relabeled** as a swap: same signer got value back AND a known DEX is present |
| `FULL_TOKEN_ACCOUNT_DRAIN` | high | **signer-owned** token account pre > 0 and post == 0 (not a swap) |
| `LARGE_TOKEN_OUTFLOW` | low (≥ 50% of balance) / medium (≥ 90%) | partial decrease on a **signer-owned** token account (not a swap) |
| `SET_AUTHORITY` | high | spl-token `setAuthority` |
| `ACCOUNT_REASSIGN` | medium | system `assign` |
| `TOKEN_DELEGATE_APPROVE` | medium | spl-token `approve` / `approveChecked` |
| `CLOSE_TOKEN_ACCOUNT` | medium | spl-token `closeAccount` |
| `PROGRAM_DEPLOY_OR_UPGRADE` | medium | BPF Upgradeable Loader involved |
| `MANY_WRITABLE_ACCOUNTS` | low | writable count ≥ 12 |
| `HIGH_FEE` | low | fee > 0.01 SOL |
| `NEW_ACCOUNT_CREATION` | info | system `createAccount` / `createAccountWithSeed` / `allocate` |
| `MULTIPLE_SIGNERS` | info | > 1 signer |
| `COMPUTE_BUDGET_SET` | info | Compute Budget program used |
| `MEMO_PRESENT` | info | Memo program used |

*(Wrapped SOL is excluded from the token-movement rules above. The native-SOL rules cover it.)*

### Honest limitations (today)

- **Heuristics are signals, not verdicts.** "Unrecognized" does not mean "malicious," and a clean report is not a safety guarantee.
- **The watchlist is best-effort and non-exhaustive.** It is seeded conservatively (only the burn address) precisely to avoid false accusations. Absence from it means nothing.
- **The LLM layer is wired but not yet billing live.** Real Claude explanations turn on the moment the Anthropic account is funded. Until then the free deterministic placeholder is used. The model is constrained to the provided facts and the deterministic score is the source of truth, so model output is advisory either way.
- **Public RPC rate-limits and prunes old transactions.** Production uses a Helius RPC. A custom RPC URL (per request or via `SOLANA_RPC_URL`) works around limits elsewhere.
- **The `rpcUrl` passthrough lets the server fetch a client-supplied URL.** The baseline SSRF guard (`assertSafeRpcUrl`) ships today. A positive host allowlist remains for hardened production.
- **No persistence, no auth.** Reviews are computed on demand.
- **The pre-sign path has its own honest limits.** The fee is estimated via `getFeeForMessage` and can show as not-applicable if the RPC cannot price the message. The instruction-type decoder covers SPL Token and System only. Other programs' instruction types are not decoded, though the balance, program, and watchlist heuristics still apply. It needs a custom RPC, because public RPC rate-limits simulate-with-accounts. And because the blockhash is replaced, the real result after signing can differ if on-chain state changes before submission.

---

## 2. Roadmap (next milestones)

The headline work is shipped and lives in [section 1](#1-current-status-what-is-done-today): pre-sign simulation, token metadata, the real dual-provider LLM seam, the public Vercel deploy, the premium UI, the sample generator, and the 24-check suite. What follows is the remaining work. Estimates reflect the agent-assisted pace this project was actually built at, so they are in days. Each milestone ships independently and builds on the existing contract in `src/lib/types.ts`.

### N1: Turn Claude on in production and harden the LLM guardrails

The dual-provider seam is **already wired and deployed** (Anthropic/OpenAI, prompt caching, mode-aware prompt, graceful fallback, see [section 1](#1-current-status-what-is-done-today)). The remaining step to make real Claude explanations live is trivial. Fund the Anthropic account. The key and `AI_PROVIDER=anthropic` are already set in production, and `GET /api/ai-status?test=1` confirms the wiring. This milestone also hardens the seam.

**Deliverables**
- Fund the Anthropic account so production serves real Claude output (the free placeholder remains the fallback on any error).
- Tighten guardrails: output-length caps (in place), explicit timeouts and retries, and a small cost budget per request.
- Structured-output validation beyond the current shape check (reject hallucinated addresses or amounts not present in the `ParsedTransaction`/`RiskReport`).
- A `.env.example` and docs covering provider selection, model defaults, prompt caching, and cost. A tiny offline fixture test for the JSON-parsing and fallback path.
- Optional: stream the explanation to the UI.

**Effort:** about half a day (funding is minutes).

**Acceptance criteria**
- With the account funded, `provider`/`model` reflect the real provider and production shows Claude output. With no credits or no key, behavior is identical to the free placeholder (no failed request).
- The explanation never asserts an address or amount absent from the data it was given.
- A provider timeout or error degrades gracefully to the placeholder rather than failing the request (already true. This milestone adds the timeout/budget caps and a test).

---

### N2: Richer program/IDL labeling and a CPI tree view

Token metadata enrichment already shipped (see [section 1](#1-current-status-what-is-done-today)), so symbols, names, and logos render today. This milestone makes the instruction-level data more legible, which gives both the heuristics and the explanation more context.

**Deliverables**
- **Program/IDL enrichment:** keep expanding `programs.ts` and best-effort label partially-decoded instructions. Surface friendlier `parsedType` and account roles. Extend the pre-sign discriminator decoder beyond SPL Token and System so more programs' instruction types are named in the simulated path.
- **CPI depth and call-tree view:** render the flattened top-level plus inner instruction list as a readable nested tree (the data already distinguishes inner instructions via `isInner`/`parentIndex`, and the simulated path already carries them).
- Caching/memoization for any added metadata lookups to limit extra RPC/HTTP calls.

**Effort:** about 1 day.

**Acceptance criteria**
- Previously "unrecognized" but well-known instructions are labeled, reducing `UNKNOWN_PROGRAM` noise.
- Inner/CPI instructions are visibly grouped under their parent.
- Enrichment is additive. The `ParsedTransaction` contract still validates and all prior behavior is unchanged when lookups fail.

---

### N3: Expanded heuristics, threat intel, and hardening

Increase detection coverage and precision, grow the threat intelligence from public sources, and harden the service for shared or production use.

**Deliverables**
- New or refined rules: suspicious destination concentration, multi-step drain sequences (approve then transfer then close in one tx), Token-2022 transfer-hook / extension red flags, dust/poisoning transfers, and further outflow tuning.
- **Grow the watchlist** (`src/lib/watchlist.ts`) from public, citable disclosures only, with each entry sourced, keeping the "best-effort, not financial advice" framing. The matching mechanism is already live.
- A simple way to keep lists fresh (a versioned data file or scheduled fetch) with per-finding source attribution.
- **Hardening:** upgrade the baseline `rpcUrl` SSRF guard (`assertSafeRpcUrl`) to a positive host allowlist, add rate limiting and input limits, and add structured logging and observability.
- **Persistence:** optional storage of reviews for history, sharing, and de-duplication (the permalink already gives a shareable surface).
- Consider migrating the RPC layer to `@solana/kit` (web3.js v2) if it materially improves bundle size or ergonomics.

**Effort:** a few days, and ongoing.

**Acceptance criteria**
- New rules fire correctly on fixtures and do not regress existing rule outputs (the `npm test` suite grows alongside them).
- Watchlist hits produce a clear, sourced finding. Every finding still carries human-readable evidence and the "signals, not a verdict" disclaimer.
- The `rpcUrl` passthrough is constrained to a vetted allowlist (or disabled) in the hardened config. Rate limiting and persistence are in place and documented. The service is safe to expose beyond the current demo.
- Still no code path signs or submits a transaction on the user's behalf.

---

## 3. Timeline & budget mapping

The deadline is June 11, 2026 (Asia/Dubai). A micro-grant funds a focused increment, not the whole roadmap. The headline work is already built and deployed. The funded work fits comfortably inside the deadline with room to spare.

### Primary KPI

A routine DEX swap reviews LOW (score < 25) and a genuine drainer reviews HIGH (score ≥ 45), deterministically, with explainable evidence, and an agent or user can run that same review on an *unsigned* transaction before approving it. This single false-positive-versus-true-positive separation, extended to the pre-sign moment, is the headline outcome the grant is judged on. It is proven post-hoc by `npm test` (24/24), and proven pre-sign by a live mainnet integration where an unsigned transfer to the burn address surfaced the SOL deltas and fired the watchlist rule before signing. It is also live to try at https://solana-agentic-tx-reviewer.vercel.app.

### Timeline (days)

| When | Focus | Milestone |
| --- | --- | --- |
| Done | Working reviewer, pre-sign simulation, token metadata, real LLM seam, tuned 18-rule engine, watchlist, permalink + OG card, sample generator, premium UI, 24-check tests, public git, and a **live Vercel deploy** | **Shipped** |
| Day 1 | Fund Anthropic to turn Claude on, then deepen and guard the LLM layer, with `.env.example` + docs | **N1 (within grant)** |
| Day 2 | Richer program/IDL labeling and a CPI tree view | **N2 (stretch / post-grant)** |
| Day 3+ | Expanded heuristics, watchlist growth, hardening, persistence | **N3 (post-grant)** |

### Budget / scope mapping (~200 USDG)

A ~200 USDG award is treated as a focused bounty, not a salary. The headline work (pre-sign simulation, the real LLM seam, the public deploy, the redesign) is already shipped and verified, so the funded commitment is intentionally modest:

| Item | Scope | Indicative share |
| --- | --- | --- |
| **Pre-sign simulation + deploy** | Unsigned-tx simulation through the existing parse → risk → explain pipeline, live on Vercel and live-verified | Primary deliverable, delivered |
| **N1, Claude-on + LLM hardening** | Fund Anthropic to serve real Claude in production, then add timeout/cost caps, output validation, docs on the already-shipped seam | Within the grant |
| LLM API usage during development | Capped, budgeted test calls. The free placeholder keeps day-to-day cost at zero | Minor |
| Documentation & demo | README, demo video/GIF, `.env.example`, the live URL, the shareable permalink | Included |

N2 and N3 are scoped here so reviewers can see the full vision, but they are **not** promised under the micro-grant. They would be pursued as follow-on work. This keeps the commitment honest and achievable.

---

## 4. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Public RPC rate-limits / prunes old transactions** | High | Medium | Production uses a Helius RPC. Custom RPC supported per-request and via `SOLANA_RPC_URL`. The pre-sign path needs one, since public RPC rate-limits simulate-with-accounts. Caching in N2. |
| **LLM hallucination** (invents addresses/amounts/intent) | Medium | High | Strict "use only provided facts" system prompt (in `src/lib/ai.ts`). The deterministic risk score is the source of truth. The explanation is framed as advisory with caveats. Free placeholder default and **graceful fallback on any error**. Output validation tightened in N1. |
| **Over-trust in heuristics** (users read "low risk" as "safe") | Medium | High | Consistent "signals, not a verdict / not financial advice" disclaimers in `caveats` and the UI. Encourage verification on a trusted explorer (Solscan link in the result). |
| **False positives** (legit large transfers or swaps, unknown-but-safe programs) | Medium | Medium | Signer-scoped drain rules, swap-aware `TOKEN_SWAP` relabel, WSOL exclusion, and score de-saturation already cut the main offenders. Pinned by `npm test`. Further calibration in N3. |
| **Watchlist false accusation** | Low | High | `src/lib/watchlist.ts` is best-effort, non-exhaustive, and seeded only with the burn address. New entries require a citable public source. Flagged-programs list empty by default. |
| **SSRF via client-supplied `rpcUrl`** | Low (demo) to High (if widely exposed) | High | Baseline guard `assertSafeRpcUrl` already blocks loopback/private/metadata hosts (http(s) only, 400 on violation). N3 adds a positive host allowlist plus rate limiting before any broad public exposure. |
| **LLM API cost overruns** | Low | Medium | Free placeholder is the fallback. Real provider gated behind `AI_PROVIDER` plus a funded key. Anthropic prompt caching on the system prompt. Length caps now, timeout/budget caps in N1. |
| **Simulation drift** (pre-sign blockhash/replace semantics, partial sim) | Medium | Medium | The recipe is de-risked, shipped, and deployed (`replaceRecentBlockhash`, `sigVerify: false`, explicit `accounts.addresses`). Deltas are derived against `getMultipleAccountsInfo`. Failures map to a typed `ReviewError`. The caveat that a replaced blockhash means the post-sign result can differ is surfaced in the explanation. |
| **Upstream breakage** (web3.js v1 EOL, RPC API drift) | Low | Medium | Pinned versions. `@solana/kit` (v2) noted as a migration path. The thin, isolated RPC layer (`src/lib/solana.ts`) makes swapping cheap. |
| **Scope creep beyond a micro-grant** | Medium | Medium | The headline work is already shipped and deployed. N1 is the only further firmly funded work, and most of it is funding the Anthropic account. N2 to N3 are explicitly marked stretch or post-grant. |

---

## Contact & links

<!-- PLACEHOLDER: fill in demo video, payout wallet, and contact before submission. Do not invent values. -->

- **Repository:** https://github.com/plutohan/solana-agentic-tx-reviewer
- **Live demo:** https://solana-agentic-tx-reviewer.vercel.app
- **Demo video:** _TODO (placeholder)_
- **Payout wallet (USDG):** _TODO (placeholder)_
- **Contact:** _TODO (placeholder)_

---

*This is a read-only reviewer. It analyzes and explains transactions. It never signs or sends them. Risk heuristics and the watchlist are best-effort signals, not a security guarantee or financial advice. Always verify on a trusted block explorer before acting.*
