# Milestones & Delivery Plan

**Project:** Solana Agentic Transaction Reviewer
**Grant:** Superteam Agentic Engineering micro-grant (~200 USDG, Solana Earn)
**Status:** Working build — the explainable safety-review step in the agent loop. See [Current Status](#1-current-status--what-is-done-today).
**Scope discipline:** read-only analysis only. No new protocol. No signing or sending of transactions.

This document is the delivery plan for the grant. It leads with the agentic-engineering framing (why this matters and how it was built), states honestly what exists today, then lays out an incremental roadmap (M1–M4) — with **pre-sign simulation** as the headline next milestone — followed by a timeline, a budget mapping appropriate to a micro-grant, and a risk register.

---

## 0. Agentic-engineering framing (why this matters)

**Becoming an agent — the reviewer is the explainable safety-review step in the agent loop.** On Solana's road to autonomous, transaction-signing agents, the missing piece is judgment: a step that reads a transaction and says, in plain English, *what it does and how risky it is* before anyone (or anything) approves it. This project is exactly that step. The loop it slots into:

```
agent proposes a transaction → reviewer judges it (parse → heuristics → explanation) → human or agent approves
```

The reviewer is deterministic where it must be (the risk score is a pure function of the on-chain facts) and explainable everywhere (every finding carries human-readable evidence; the natural-language layer is told to use *only* the provided facts). That makes its output safe to put in front of an automated approver: a swap reads LOW, a real drainer reads HIGH, and the reasoning is auditable.

**Built with agents.** This codebase was scaffolded, documented, and adversarially reviewed by a multi-agent workflow:

- A research-agent discovery pass **confirmed the program IDs** now in the registry (PumpSwap, pump.fun Fee, Raydium CLMM/CPMM, Meteora DLMM/DAMM v2, Phoenix, Lifinity v2, Jupiter v4, Jito Tip) and **de-risked the heuristics** (the signer-scoping and swap-aware fixes below came directly out of that review).
- Agents updated the toolchain to current (Node 24.16.0, Rust 1.96.0, Agave 4.0.1, Anchor 1.0.2) and the web stack (Next 16, React 19, TS 6, Tailwind 4).
- The pre-sign-simulation recipe in [M1](#m1--pre-sign-simulation-headline) was de-risked the same way: researched, sketched, and reduced to a concrete RPC recipe before any code is written.

---

## 1. Current Status — what is done today

A working Next.js (App Router) web app. A user (or an agent) supplies a transaction signature; the app fetches the transaction read-only over Solana RPC, normalizes it into a shared data model, runs deterministic risk heuristics, and renders a human-readable explanation plus a risk report. The same pipeline also backs a server-rendered shareable permalink.

The full pipeline is live end-to-end:

```
RPC fetch → parse() → assessRisk() → explainTransaction() → ReviewResult
(served by POST /api/review AND by GET /tx/<signature>)
```

### What actually works

- **Read-only RPC layer** (`src/lib/solana.ts`): the app only ever calls `getParsedTransaction` (with `maxSupportedTransactionVersion: 0`, `commitment: "confirmed"`). There is no code path that signs or submits anything. `resolveRpcUrl()` picks an endpoint with the precedence `request.rpcUrl > SOLANA_RPC_URL (mainnet only) > public cluster default`, `isValidSignature()` does cheap base58 structural validation before any network call, and `assertSafeRpcUrl()` is a baseline SSRF guard (http(s) only; loopback/private/metadata hosts rejected) on any client-supplied URL.
- **Deterministic extraction** (`src/lib/parse.ts`): `parseTransaction(raw, signature, cluster)` normalizes the raw RPC response into the `ParsedTransaction` model. It computes per-account SOL deltas (post − pre balances), SPL token balance changes (from `pre`/`postTokenBalances`, including each account's `owner`), flattens top-level **and** inner (CPI) instructions into one list, and aggregates `programsInvoked` with counts. Everything downstream reads only this normalized shape.
- **Shared data model / contract** (`src/lib/types.ts`): `ReviewRequest`, `AccountSummary`, `InstructionSummary`, `TokenBalanceChange`, `ProgramInvocation`, `ParsedTransaction`, `RiskLevel`, `RiskFinding`, `RiskReport`, `AiExplanation`, and `ReviewResult`. The UI, the API, the permalink, the risk engine, and the LLM all speak this one contract.
- **Program registry** (`src/lib/programs.ts`): a curated map of well-known program IDs → `{ name, category }`, covering System, SPL Token, SPL Token-2022, Associated Token Account, Compute Budget, Memo (v1 + current), BPF loaders, Stake, Vote, Metaplex Token Metadata, **and a research-confirmed DeFi set**: Jupiter Aggregator v6 **and v4**, Raydium AMM v4 / **CLMM** / **CPMM**, Orca Whirlpools, pump.fun (bonding curve) + **pump.fun Fee**, **PumpSwap AMM**, **Meteora DLMM** + **DAMM v2**, **Phoenix**, **Lifinity v2**, and **Jito Tip Payment**. Exposes `resolveProgram()`, `isKnownProgram()`, the `WSOL_MINT` constant, a `DEX_PROGRAM_IDS` set, and `isDexProgram()`.
- **Deterministic risk engine** (`src/lib/heuristics.ts`): **18** pure-function rules that emit explainable `RiskFinding`s with evidence (up from 16 — added `TOKEN_SWAP` and `FLAGGED_ADDRESS`). Score and level aggregation are deterministic (details in the [scoring](#risk-scoring-as-implemented-in-srclibheuristicsts) section and rules table below). These are explicitly **signals, not a verdict**. The major tuning shipped this round:
  - **Signer-scoped drain/outflow.** `FULL_TOKEN_ACCOUNT_DRAIN` and `LARGE_TOKEN_OUTFLOW` now only fire on token accounts **owned by a signer**. Pool/vault accounts (owned by program PDAs) routinely zero out during a swap and are ignored — this killed the biggest false positive (a routine Jupiter/PumpSwap swap previously read HIGH "fully drained" off a *pool* account).
  - **Wrapped SOL excluded.** WSOL (`So111…112`) is skipped by the token drain/outflow rules — it is transient (wrap/unwrap) and the native-SOL rules already cover it.
  - **`TOKEN_SWAP` (new, low).** Defensively **relabels** a would-be full-drain / large-outflow when the *same signer* received non-dust value back (a different-mint token inflow `> 1` base unit, or net SOL `> 0.001`) **and** a known DEX program is present — consistent with a swap / position exit, not a drain. An undefined owner or a dusted fake inflow fails safe to the higher-risk drain finding.
  - **`FLAGGED_ADDRESS` (new, from `src/lib/watchlist.ts`).** A curated, **best-effort, non-exhaustive, not-financial-advice** watchlist. Seeded honestly with only the well-known SOL burn/incinerator address (`FLAGGED_ADDRESSES`); the same mechanism matches flagged program IDs (`FLAGGED_PROGRAMS`, intentionally empty to avoid false accusations). `lookupWatch()` is fully wired so the list grows without code changes.
  - **Scoring de-saturation.** `assessRisk()` now de-dupes same-id findings (`dedupeFindings`, merging evidence and tagging `×N`) and applies **diminishing returns** (the k-th finding at a level adds `weight * 0.5^k`, via `computeScore`). A routine busy swap reads LOW; a real, *stacked* drainer stays HIGH. `LEVEL_WEIGHT` is unchanged (`info 0 / low 10 / medium 25 / high 45`).
- **Real LLM explanation seam** (`src/lib/ai.ts`): `explainTransaction(tx, risk)` now genuinely calls **Anthropic or OpenAI** behind the existing dual-provider seam — gated on `AI_PROVIDER` + the matching key — and maps the model's JSON into the existing `AiExplanation` shape (no schema change). The default is a **free, deterministic placeholder**, and **any** error (missing key, network, rate limit, bad JSON) degrades gracefully back to it, so the app always works and stays free by default. Anthropic requests apply **prompt caching** to the static system prompt (`cache_control: ephemeral`). The system prompt instructs the model to use *only* the provided facts. The "agentic" claim is substantiated the moment a key is configured; zero-key still works.
  - Env: `AI_PROVIDER=anthropic|openai`, `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`), `OPENAI_API_KEY` / `OPENAI_MODEL` (default `gpt-4o-mini`).
- **Orchestration + API** (`src/lib/review.ts`, `src/app/api/review/route.ts`): `reviewTransaction(request)` runs the pipeline and throws a typed `ReviewError(status)` for clean HTTP mapping (400 invalid signature, 404 not found, 502 RPC error, 500 unexpected). `POST /api/review` runs on the Node.js runtime (`@solana/web3.js` needs Node APIs).
- **Shareable permalink + OG card** (`src/app/tx/[signature]/page.tsx`, `src/app/tx/[signature]/opengraph-image.tsx`): `GET /tx/<signature>?cluster=…` server-renders the **full** `reviewTransaction` pipeline and reuses `ResultView` / `RiskBadge` — **zero new risk logic**. A Next 16 `ImageResponse` OG card (risk level + score + short signature + a one-line summary) makes a pasted link unfurl into a risk preview. `metadataBase` comes from `NEXT_PUBLIC_SITE_URL` (falls back to `http://localhost:3000`, in `src/app/layout.tsx`). The home page (`src/app/page.tsx`) now surfaces an "Open shareable permalink ↗" link.
- **UI** (`src/app/page.tsx`, `src/components/ResultView.tsx`, `src/components/RiskBadge.tsx`): a client form for signature input, cluster select, and an optional custom RPC URL, rendering the parsed transaction, risk findings, and explanation.
- **Regression tests** (`tests/heuristics.test.ts`, run via `npm test` → `tsx`): **10** deterministic checks that pin the tuning above and need no live RPC — a DEX sell relabels to `TOKEN_SWAP` (not HIGH, score `< 25`); a genuine drain is `FULL_TOKEN_ACCOUNT_DRAIN` / HIGH / score `≥ 45`; a pool/vault (non-signer) zero-out is ignored; a signer WSOL outflow is ignored; and the burn-address watchlist fires. All pass. `tsx` is a dev dependency.
- **Git.** The project is now a git repository (a baseline commit plus this enhancement round).

### Toolchain (brought current as part of this project)

| Layer | Version |
| --- | --- |
| Node.js | 24.16.0 LTS |
| npm | 11.16.0 |
| Next.js (App Router) | 16.2.7 |
| React | 19.2.7 |
| TypeScript | 6.0.3 |
| Tailwind CSS | 4.3.0 (CSS-first: `@import "tailwindcss"` + `@tailwindcss/postcss`; **no** `tailwind.config.js`) |
| `@solana/web3.js` | 1.98.4 (the v1 line; v2 lives on as `@solana/kit` 6.x — noted as a future option) |

The broader Solana dev toolchain on the machine is also current — Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2 — though **none of these are used by this read-only web app**; the environment was simply brought up to date (by agents) for completeness.

### Risk scoring (as implemented in `src/lib/heuristics.ts`)

- `LEVEL_WEIGHT`: `info = 0`, `low = 10`, `medium = 25`, `high = 45` (unchanged).
- **Score** = `clamp(sum, 0, 100)` where, per level, the k-th finding contributes `weight * 0.5^k` (**diminishing returns** — de-saturates busy-but-benign transactions while keeping stacked high-severity signals near the top).
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

*(Wrapped SOL is excluded from the token-movement rules above; native-SOL rules cover it.)*

### Honest limitations (today)

- **Heuristics are signals, not verdicts.** "Unrecognized" does not mean "malicious," and a clean report is not a safety guarantee.
- **The watchlist is best-effort and non-exhaustive.** It is seeded conservatively (only the burn address) precisely to avoid false accusations; absence from it means nothing.
- **The LLM layer can still be wrong.** It is constrained to the provided facts and the deterministic score is the source of truth, but model output is advisory — and it only runs when a key is configured (otherwise the free placeholder is used).
- **Public RPC rate-limits and prunes old transactions.** A custom RPC URL (per request or via `SOLANA_RPC_URL`) works around this.
- **The `rpcUrl` passthrough lets the server fetch a client-supplied URL.** The baseline SSRF guard (`assertSafeRpcUrl`) ships today; a positive host allowlist remains for production.
- **No persistence, no auth.** Reviews are computed on demand.
- **Post-hoc only (for now).** Today the reviewer judges a *confirmed* signature; reviewing an *unsigned* transaction before approval is [M1](#m1--pre-sign-simulation-headline) below.

---

## 2. Milestones

Effort estimates assume one part-time engineer. They are deliberately modest and incremental; each milestone ships independently and builds on the existing contract in `src/lib/types.ts`. **M0 (the working reviewer above) is done.** **M1 — pre-sign simulation — is the headline next milestone.**

### M0 — Working reviewer (DONE)

Everything in [§1](#1-current-status--what-is-done-today): the read-only pipeline, the 18-rule signer-scoped, swap-aware, de-saturated risk engine, the real dual-provider LLM seam with a free placeholder default, the watchlist, the shareable permalink + OG card, the regression suite, and a git history.

**Acceptance criteria (met)**
- Pasting a real mainnet signature returns a parsed transaction, a risk report, and a readable explanation **with no API keys configured** (free placeholder); with `AI_PROVIDER` + a key, the explanation is genuinely model-generated and `provider`/`model` reflect it.
- A routine DEX swap reads LOW (relabeled `TOKEN_SWAP`, score `< 25`); a genuine drain reads HIGH (`≥ 45`); pool/vault and WSOL noise is filtered; the watchlist fires. Proven by `npm test` (10 checks, all passing).
- `GET /tx/<signature>` server-renders the same review and unfurls with an OG risk card.
- Invalid signatures, not-found transactions, and RPC failures return the correct HTTP status via `ReviewError`.
- The full chain runs entirely read-only — no signing or sending code exists.

---

### M1 — Pre-sign simulation (HEADLINE)

**The flagship next step, and the clearest expression of the agentic framing:** move from "review a confirmed signature after the fact" to "review an **unsigned** transaction *before* approving it." This is what lets an agent — or a human using a wallet — see a plain-English explanation and a risk score for a transaction it is *about* to sign, closing the agent loop (`propose → review → approve`). **Not built yet; the recipe is de-risked and concrete.**

**Technical approach (de-risked recipe)**
- Accept a base64 **unsigned** `VersionedTransaction` (in addition to today's confirmed signature).
- Simulate read-only via `connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: "base64", addresses } })`, where `addresses` are the writable accounts we want post-state for.
- Derive balance/account **deltas** from the simulation: compare the returned post-state against pre-state fetched with `getMultipleAccountsInfo` for the same `addresses` (SOL + SPL token deltas, mirroring what `parse.ts` computes from `pre`/`post` today).
- Feed those deltas, the simulated `innerInstructions` (CPI tree), and `logs` through the **same** `parse → assessRisk → explainTransaction` pipeline — **zero new risk logic**, reusing the `ParsedTransaction` contract and `ResultView`.
- Surface it as a new input mode (and a programmatic endpoint) so a wallet/agent can submit an unsigned tx and receive the structured `ReviewResult` before deciding to sign.

**Effort / time:** ~1–1.5 weeks.

**Acceptance criteria**
- A user/agent can submit an **unsigned** base64 transaction and receive a risk report + explanation derived purely from simulation — fully read-only, no signature required.
- The simulated path produces a `ParsedTransaction` shaped identically to the confirmed path, so all existing heuristics and the explanation layer apply unchanged.
- Simulation failures (bad blockhash, program error) degrade to a clear, typed error via `ReviewError`.
- Still no code path signs or submits a transaction — the tool advises; the human/agent decides.

---

### M2 — Real LLM explanation, deepened

The dual-provider seam is **already wired and shipped** (Anthropic/OpenAI, prompt caching, graceful fallback — see [§1](#1-current-status--what-is-done-today)). M2 hardens and extends it.

**Deliverables**
- Tighten guardrails: output-length caps (in place), explicit timeouts/retries, and a small cost budget per request.
- Structured-output validation beyond the current shape check (reject hallucinated addresses/amounts not present in the `ParsedTransaction`/`RiskReport`).
- A `.env.example` and docs covering provider selection, model defaults, prompt caching, and cost; a tiny offline fixture test for the JSON-parsing/fallback path.
- Optional: stream the explanation to the UI.

**Effort / time:** ~3–5 days.

**Acceptance criteria**
- With a key set, `provider`/`model` reflect the real provider; with no key, behavior is identical to the free placeholder (no LLM network call).
- The explanation never asserts an address/amount absent from the data it was given.
- A provider timeout or error degrades gracefully to the placeholder rather than failing the request (already true; M2 adds the timeout/budget caps and a test).

---

### M3 — Richer parsing & metadata enrichment

Make the extracted data more legible so both the heuristics and the explanation have more context.

**Deliverables**
- **Mint metadata enrichment:** resolve symbol/name/decimals/logo per `TokenBalanceChange` so the UI shows "−1,250 USDC" instead of a raw mint and base-unit delta.
- **Program/IDL enrichment:** continue expanding `programs.ts` and best-effort label partially-decoded instructions; surface friendlier `parsedType` and account roles.
- **CPI depth & call-tree view:** render the flattened top-level + inner instruction list as a readable nested tree (the data already distinguishes inner instructions).
- Caching/memoization for metadata lookups to limit extra RPC/HTTP calls.

**Effort / time:** ~1–1.5 weeks.

**Acceptance criteria**
- Token changes render with human-readable symbols/amounts where metadata is available, and degrade cleanly (raw mint) where it is not.
- Previously "unrecognized" but well-known instructions are labeled, reducing `UNKNOWN_PROGRAM` noise.
- Inner/CPI instructions are visibly grouped under their parent.
- Enrichment is additive: the `ParsedTransaction` contract still validates and all prior behavior is unchanged when lookups fail.

---

### M4 — Expanded heuristics, threat intel & hardening

Increase detection coverage and precision, grow the threat intelligence, and harden the service for shared/production use.

**Deliverables**
- New/refined rules: suspicious destination concentration, multi-step drain sequences (approve → transfer → close in one tx), Token-2022 transfer-hook / extension red flags, dust/poisoning transfers, and further outflow tuning.
- **Grow the watchlist** (`src/lib/watchlist.ts`) from public, citable disclosures only — each entry sourced — keeping the "best-effort, not financial advice" framing; the matching mechanism is already live.
- A simple way to keep lists fresh (versioned data file or scheduled fetch) with per-finding source attribution.
- **Hardening:** upgrade the baseline `rpcUrl` SSRF guard (`assertSafeRpcUrl`) to a positive host allowlist, add rate limiting and input limits, and add structured logging/observability.
- **Persistence:** optional storage of reviews for history, sharing, and de-duplication (the permalink already gives a shareable surface).
- Consider migrating the RPC layer to `@solana/kit` (web3.js v2) if it materially improves bundle size or ergonomics.

**Effort / time:** ~1.5–2.5 weeks.

**Acceptance criteria**
- New rules fire correctly on fixtures and do not regress existing rule outputs (the `npm test` suite grows alongside them).
- Watchlist hits produce a clear, sourced finding; every finding still carries human-readable evidence and the "signals, not a verdict" disclaimer.
- The `rpcUrl` passthrough is constrained to a vetted allowlist (or disabled) in the hardened config; rate limiting and persistence are in place and documented; the service is safe to expose beyond localhost.
- Still no code path signs or submits a transaction on the user's behalf.

---

## 3. Timeline & budget mapping

Dates are in Asia/Calcutta. A micro-grant funds a focused increment, not the whole roadmap; the funded scope is small and credible, and M3–M4 are the natural follow-on path beyond the grant.

### Primary KPI

**A routine DEX swap reviews LOW (score < 25) and a genuine drainer reviews HIGH (score ≥ 45) — deterministically, with explainable evidence — and an agent/user can run that same review on an *unsigned* transaction before approving it (M1).** This single false-positive-vs-true-positive separation, extended to pre-sign, is the headline outcome the grant is judged on. It is already proven post-hoc by `npm test` (10/10); M1 brings it to the pre-sign moment.

### Timeline (weeks)

| Week | Focus | Milestone |
| --- | --- | --- |
| 0 | — | **M0 already delivered** (working reviewer: real LLM seam, tuned 18-rule engine, watchlist, permalink, tests, git) |
| 1 | **Pre-sign simulation** of an unsigned tx through the same pipeline | **M1 (headline, funded)** |
| 2 | Deepen/guard the LLM layer; `.env.example` + docs | **M2** (within grant if time allows) |
| 3–4 | Mint + program/IDL enrichment; CPI tree view | **M3** (stretch / post-grant) |
| 5–6 | Expanded heuristics, watchlist growth, hardening, persistence | **M4** (post-grant) |

### Budget / scope mapping (~200 USDG)

A ~200 USDG award is treated as a focused bounty, not a salary. The funded commitment is intentionally modest:

| Item | Scope | Indicative share |
| --- | --- | --- |
| **M1 — Pre-sign simulation** | Unsigned-tx simulation through the existing parse → risk → explain pipeline | Primary funded deliverable |
| **M2 (partial) — LLM hardening** | Timeout/cost caps, output validation, docs on the already-shipped seam | Secondary, if time allows |
| LLM API usage during development | Capped/budgeted test calls; the free placeholder keeps day-to-day cost at zero | Minor |
| Documentation & demo | README, demo video/GIF, `.env.example`, the shareable permalink | Included |

M3 and M4 are scoped here so reviewers can see the full vision, but they are **not** promised under the micro-grant; they would be pursued as follow-on work. This keeps the commitment honest and achievable.

---

## 4. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Public RPC rate-limits / prunes old transactions** | High | Medium | Custom RPC supported per-request and via `SOLANA_RPC_URL`; document recommended providers; caching in M3. |
| **LLM hallucination** (invents addresses/amounts/intent) | Medium | High | Strict "use only provided facts" system prompt (in `src/lib/ai.ts`); deterministic risk score is the source of truth; explanation framed as advisory with caveats; free placeholder default and **graceful fallback on any error**; output validation tightened in M2. |
| **Over-trust in heuristics** (users read "low risk" as "safe") | Medium | High | Consistent "signals, not a verdict / not financial advice" disclaimers in `caveats` and UI; encourage verification on a trusted explorer. |
| **False positives** (legit large transfers / swaps, unknown-but-safe programs) | Medium | Medium | Signer-scoped drain rules, swap-aware `TOKEN_SWAP` relabel, WSOL exclusion, and score de-saturation already cut the main offenders; pinned by `npm test`; further calibration in M4. |
| **Watchlist false accusation** | Low | High | `src/lib/watchlist.ts` is best-effort, non-exhaustive, and seeded only with the burn address; new entries require a citable public source; flagged-programs list empty by default. |
| **SSRF via client-supplied `rpcUrl`** | Low (local) → High (if exposed) | High | Baseline guard `assertSafeRpcUrl` already blocks loopback/private/metadata hosts (http(s) only, 400 on violation); M4 adds a positive host allowlist + rate limiting before any public deployment. |
| **LLM API cost overruns** | Low | Medium | Free placeholder is the default; real provider gated behind `AI_PROVIDER` + key; Anthropic prompt caching on the system prompt; length caps now, timeout/budget caps in M2. |
| **Simulation drift** (M1: blockhash/replace semantics, partial sim) | Medium | Medium | Recipe de-risked (`replaceRecentBlockhash`, `sigVerify:false`, explicit `accounts.addresses`); deltas derived against `getMultipleAccountsInfo`; failures map to a typed `ReviewError`. |
| **Upstream breakage** (web3.js v1 EOL, RPC API drift) | Low | Medium | Pinned versions; `@solana/kit` (v2) noted as a migration path; thin, isolated RPC layer (`src/lib/solana.ts`) makes swapping cheap. |
| **Scope creep beyond a micro-grant** | Medium | Medium | M1 (pre-sign) is the only firmly funded deliverable; M2–M4 explicitly marked as stretch/post-grant. |

---

## Contact & links

<!-- PLACEHOLDER: add repository URL, live demo URL, demo video, payout wallet, and contact (e.g. Superteam handle / email) before submission. Do not invent values. -->

- **Repository:** _TODO (placeholder)_
- **Live demo:** _TODO (placeholder)_
- **Demo video:** _TODO (placeholder)_
- **Payout wallet (USDG):** _TODO (placeholder)_
- **Contact:** _TODO (placeholder)_

---

*This is a read-only reviewer. It analyzes and explains transactions; it never signs or sends them. Risk heuristics and the watchlist are best-effort signals, not a security guarantee or financial advice — always verify on a trusted block explorer before acting.*
