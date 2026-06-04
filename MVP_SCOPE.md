# MVP Scope — Solana Agentic Transaction Reviewer

> A lightweight, AI-assisted, **read-only** Solana transaction reviewer. Paste a transaction
> signature; get a plain-English explanation plus a deterministic risk report. Nothing is ever
> signed or sent.

This document defines the scope of the proof-of-concept (PoC) MVP built for the
**Superteam Agentic Engineering Grant** (~200 USDG). It is intentionally narrow, and every claim
below is tied to code that actually exists in this repository.

| | |
| --- | --- |
| **Status** | Proof-of-concept (PoC) |
| **Mode** | Read-only analysis — no signing, no sending, no state changes |
| **Audience** | Solana users and developers who want to understand and sanity-check a transaction before or after signing |
| **AI today** | Deterministic template explanation (`provider: "placeholder"`) — zero API keys, zero cost |

---

## 1. Problem statement

Solana transactions are fast and cheap, but they are also opaque: a base58 signature on a block
explorer expands into a wall of accounts, raw instructions, inner CPIs, and pre/post balance
arrays that are hard for a human to read quickly. Users routinely sign transactions — or review
them after the fact — without a clear, plain-English picture of what moved, who gained authority,
which programs were touched, or whether the pattern looks like a drain. That gap is exactly where
people lose funds (delegate approvals, authority handovers, full token-account drains) and where
developers waste time debugging. This project closes the gap with a focused tool that turns a raw
signature into a normalized, human-readable explanation plus an explainable, deterministic risk
report — a base that a real agent can later plug into.

---

## 2. MVP goal and non-goals

### Goal

Ship a working web app where a user pastes a Solana transaction signature, selects a cluster
(optionally supplying a custom RPC), and receives:

1. A **normalized view** of the transaction — metadata, accounts with net SOL deltas, flattened
   top-level + inner (CPI) instructions, SPL token balance changes, and aggregated program
   invocations (`parseTransaction` in `src/lib/parse.ts`).
2. A **deterministic risk report** — a 0–100 score, an overall level, and individual findings with
   human-readable evidence (`assessRisk` in `src/lib/heuristics.ts`).
3. A **plain-English explanation** — a narrative summary, key-action bullets, and caveats
   (`explainTransaction` in `src/lib/ai.ts`).

The whole pipeline is a single call — `reviewTransaction(request)` in `src/lib/review.ts` — exposed
over `POST /api/review` (`src/app/api/review/route.ts`) and rendered by the client UI
(`src/app/page.tsx` → `src/components/ResultView.tsx`).

### Non-goals (explicit)

The MVP **does not**, by design:

- **No new protocol / no on-chain program.** This is a web app that reads existing transactions.
  (The machine's broader Solana toolchain — Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2 — is
  current but **not used** by this read-only app.)
- **No signing or sending.** The tool never builds, signs, simulates-for-submission, or broadcasts a
  transaction. It only calls read RPC methods (`getParsedTransaction`).
- **No persistence.** No database, no accounts, no stored history. Every review is computed on
  demand and returned in the response.
- **No real LLM yet.** The AI layer returns a deterministic, template-generated explanation
  (`AiExplanation.provider === "placeholder"`). The real provider switch exists and is stubbed; see
  §3 and the AI Layer note below.
- **No wallet connection, no transaction simulation, no portfolio/price data.**

---

## 3. In-scope features vs. out-of-scope / future

### In scope (this MVP)

| Feature | What it does | Where it lives |
| --- | --- | --- |
| Signature input + cluster select | Paste a base58 signature; choose `mainnet-beta` / `devnet` / `testnet`; optional custom RPC override | `src/app/page.tsx` |
| `POST /api/review` endpoint | Node.js-runtime route that accepts `{ signature, cluster?, rpcUrl? }` and returns a `ReviewResult` | `src/app/api/review/route.ts` |
| Signature validation | Rejects malformed input before any RPC call (86–88 char base58) | `isValidSignature` in `src/lib/solana.ts`, enforced in `src/lib/review.ts` |
| RPC resolution + fetch | Resolves endpoint (`rpcUrl` > `SOLANA_RPC_URL` env > public default) and fetches with `maxSupportedTransactionVersion: 0` | `resolveRpcUrl`, `getConnection`, `fetchParsedTransaction` in `src/lib/solana.ts` |
| Deterministic parsing | Normalizes the raw RPC response into `ParsedTransaction`: SOL deltas (post−pre), token balance changes (pre/postTokenBalances), flattened top-level + inner CPI instructions, aggregated `programsInvoked`, fee payer, signers, writable accounts | `parseTransaction` in `src/lib/parse.ts` |
| Known-program registry | Resolves program IDs to `{ name, category }` and flags unknown programs | `resolveProgram` / `isKnownProgram` in `src/lib/programs.ts` |
| Deterministic risk heuristics | 16 explainable rules → `RiskReport` (`score`, `level`, `findings[]`, `summary`) | `assessRisk` in `src/lib/heuristics.ts` (detailed in §"Risk heuristics") |
| Placeholder AI explanation | Template narrative + bullets + caveats with `provider: "placeholder"`; `buildPrompt(tx, risk)` returns the exact context a real LLM would receive | `explainTransaction`, `buildPrompt` in `src/lib/ai.ts` |
| Result rendering | Presentational view of transaction, risk, and explanation, with a risk badge | `src/components/ResultView.tsx`, `src/components/RiskBadge.tsx` |
| Typed error handling | `ReviewError(status)` maps failures to clear HTTP codes (400 / 404 / 502) surfaced in the UI | `src/lib/review.ts`, consumed by `src/app/page.tsx` |
| Custom RPC override | UI toggle ("+ custom RPC") and `rpcUrl` passthrough to avoid public-RPC rate limits / pruning | `src/app/page.tsx`, `src/lib/solana.ts` |

### Out of scope / future

| Item | Notes |
| --- | --- |
| **Real LLM explanations** | Provider switch (`placeholder` \| `openai` \| `anthropic`) is in place and stubbed in `src/lib/ai.ts`, gated by `AI_PROVIDER` env + API key. `buildPrompt()` already assembles the LLM context. |
| **Migration to `@solana/web3.js` v2** | Today uses `@solana/web3.js` 1.98.4 (the v1 line). v2 lives on as `@solana/kit` 6.x — noted as a future option. |
| **RPC allowlisting** | A baseline SSRF guard (`assertSafeRpcUrl`) already blocks loopback/private/metadata hosts; a positive host allowlist + rate limiting is the remaining production hardening. |
| **Persistence & history** | Stored reviews, shareable permalinks, batch review. |
| **Wallet connect / pre-sign hook** | Review a transaction *before* signing, inline in a wallet flow. |
| **Richer heuristics & tuning** | More rules, configurable `THRESHOLDS`, mint/price-aware outflow valuation, known-scam lists. |
| **Agent integration** | Expose `reviewTransaction()` as a tool other agents call (the pipeline is already a single function). |

---

## 4. Primary user stories

- **As a Solana user**, I paste a transaction signature and get a plain-English explanation plus
  risk flags, so I can sanity-check what a transaction did (or is about to do) without decoding raw
  instructions myself.
- **As a Solana user worried about scams**, I want full token-account drains, delegate approvals,
  and authority handovers surfaced as **high/medium** findings with evidence, so I can spot a
  drain-pattern transaction at a glance.
- **As a Solana developer debugging a failed transaction**, I paste the signature and see
  `success: false`, the decoded error, the flattened instruction list (including inner CPIs), and
  the program invocation counts, so I can pinpoint what broke faster than scrolling raw logs.
- **As a developer integrating an unfamiliar protocol**, I want any program **not** in the known
  registry flagged (`UNKNOWN_PROGRAM`), so I know to independently verify what I'm calling.
- **As a user on a rate-limited public RPC**, I want to supply my own RPC URL (Helius/QuickNode/etc.)
  via the UI or `SOLANA_RPC_URL`, so I can reliably review older or high-volume transactions.
- **As a future agent builder**, I want one deterministic function (`reviewTransaction`) that turns a
  signature into a structured `ReviewResult`, so I can plug transaction review into an automated flow.

---

## 5. Acceptance criteria

These are concrete and testable against the real pipeline
(`reviewTransaction` → `POST /api/review`).

**Input validation**

- [ ] A request with a **missing or malformed** signature (not an 86–88 char base58 string) returns
      **HTTP 400** with the message
      `Invalid transaction signature. Expected an 86–88 character base58 string.`
      and performs **no RPC call** (`isValidSignature` gate in `src/lib/review.ts`).
- [ ] The signature is trimmed and `cluster` defaults to `mainnet-beta` when omitted.

**Fetch / not-found / RPC errors**

- [ ] A **valid but non-existent** signature (pruned, wrong cluster, or unconfirmed) returns
      **HTTP 404** with
      `Transaction not found. It may be too old for this RPC, on a different cluster, or not yet confirmed.`
- [ ] An **RPC failure** (network/endpoint error) returns **HTTP 502** with a message prefixed
      `RPC error while fetching the transaction:` (`ReviewError(..., 502)`).
- [ ] A custom `rpcUrl` supplied in the request body is used for the fetch; otherwise resolution
      falls back to `SOLANA_RPC_URL` and then the public default (`resolveRpcUrl`).

**Successful review (the happy path)**

- [ ] A **valid, existing** signature returns **HTTP 200** with a `ReviewResult` containing
      `request`, `transaction`, `risk`, and `explanation`.
- [ ] `transaction` (a `ParsedTransaction`) includes: `signature`, `cluster`, `slot`, `blockTime`,
      `success`, `err`, `feeLamports`/`feeSol`, `feePayer`, `accounts[]`, `signers[]`,
      `writableAccounts[]`, `instructions[]`, `tokenBalanceChanges[]`, `programsInvoked[]`, and
      `version`.
- [ ] Each account in `accounts[]` carries a net SOL delta (`solChangeLamports` = post − pre, and
      `solChangeSol`), and `accounts[0].pubkey` is reported as `feePayer`.
- [ ] `instructions[]` contains **both** top-level and inner (CPI) instructions, flattened with a
      sequential `index`; inner instructions have `isInner: true` and a `parentIndex`.
- [ ] `tokenBalanceChanges[]` lists only accounts whose raw token amount changed, sorted by absolute
      `delta`, each with `mint`, `decimals`, pre/post raw + UI amounts, and `delta`.
- [ ] `programsInvoked[]` aggregates program-ID counts across top-level + inner instructions, sorted
      by count, with a friendly `name` when the program is in the registry.

**Risk report**

- [ ] `risk` (a `RiskReport`) returns a numeric `score` in **0–100**, an overall `level`, a
      `findings[]` array, and a one-line `summary`.
- [ ] `score` equals the clamped sum of finding weights (`info=0, low=10, medium=25, high=45`),
      capped at 100; overall `level` equals the **maximum** individual finding level.
- [ ] A transaction with **no triggered rules** returns `level: "info"`, `score: 0`, and summary
      `No notable risk signals were detected by the deterministic heuristics.`
- [ ] A transaction whose `meta.err != null` produces a `TX_FAILED` (`info`) finding and
      `transaction.success === false`.
- [ ] A transaction that **fully drains** a token account (pre > 0, post == 0) produces a
      `FULL_TOKEN_ACCOUNT_DRAIN` (`high`) finding, pushing overall `level` to `high`.
- [ ] Findings are **deterministic**: the same input transaction always yields the same `score`,
      `level`, and `findings` (no randomness, no network in `assessRisk`).

**Explanation**

- [ ] `explanation` (an `AiExplanation`) has `provider: "placeholder"`, a non-empty `summary`,
      `bullets[]`, `caveats[]`, and a `generatedAt` timestamp — and requires **no API key**.

**UI**

- [ ] The client (`src/app/page.tsx`) disables **Review** while a request is in flight or the
      signature input is empty, renders a clear error banner on non-2xx responses, and renders the
      `ResultView` on success.
- [ ] The UI states plainly that the tool is read-only ("Read-only — nothing is signed or sent.").

---

## Risk heuristics (reference)

Deterministic, explainable signals — **not** a verdict. Defined in `src/lib/heuristics.ts`.

- **Score:** `clamp(sum of level weights, 0, 100)` with `LEVEL_WEIGHT = { info: 0, low: 10, medium: 25, high: 45 }`.
- **Overall level:** the **maximum** individual finding level.
- **Thresholds (`THRESHOLDS`):** `largeSolOutflow = 1 SOL`, `veryLargeSolOutflow = 10 SOL`,
  `manyWritableAccounts = 12`, `highFeeSol = 0.01 SOL`, `largeTokenOutflowPct = 0.5`.

| ID | Level | Trigger |
| --- | --- | --- |
| `TX_FAILED` | info | `meta.err != null` |
| `UNKNOWN_PROGRAM` | medium | Invokes a program not in the registry |
| `LARGE_SOL_OUTFLOW` | medium (≥1 SOL) / high (≥10 SOL) | Fee payer net SOL decrease |
| `FULL_TOKEN_ACCOUNT_DRAIN` | high | Token account pre > 0 and post == 0 |
| `LARGE_TOKEN_OUTFLOW` | low (≥50% of balance) / medium (≥90%) | Partial token decrease |
| `SET_AUTHORITY` | high | `spl-token` `setAuthority` |
| `ACCOUNT_REASSIGN` | medium | `system` `assign` |
| `TOKEN_DELEGATE_APPROVE` | medium | `spl-token` `approve` / `approveChecked` |
| `CLOSE_TOKEN_ACCOUNT` | medium | `spl-token` `closeAccount` |
| `PROGRAM_DEPLOY_OR_UPGRADE` | medium | BPF Upgradeable Loader involved |
| `MANY_WRITABLE_ACCOUNTS` | low | Writable count ≥ 12 |
| `HIGH_FEE` | low | Fee > 0.01 SOL |
| `NEW_ACCOUNT_CREATION` | info | `system` `createAccount` / `createAccountWithSeed` / `allocate` |
| `MULTIPLE_SIGNERS` | info | More than 1 signer |
| `COMPUTE_BUDGET_SET` | info | Compute Budget program used |
| `MEMO_PRESENT` | info | Memo program used |

---

## AI layer (reference)

Today, `explainTransaction(tx, risk)` returns a **deterministic template** explanation
(`provider: "placeholder"`), so the PoC runs with **zero keys and zero cost**. `buildPrompt(tx, risk)`
returns the exact context a real LLM would receive, and the provider switch in `explainTransaction()`
shows where an OpenAI/Anthropic call slots in — gated by the `AI_PROVIDER` env var plus an API key.
Swapping in a real model does not change the data contract: it still returns an `AiExplanation`.

---

## 6. Success metrics for the PoC

The MVP is considered successful if:

- **It runs with zero secrets.** A fresh clone reviews a real `mainnet-beta` transaction with no API
  keys configured (placeholder AI) and the public default RPC.
- **Correctness on real transactions.** For a hand-picked set of real signatures covering SOL
  transfers, SPL transfers, a swap/DeFi route, a failed transaction, and a known drain/approve
  pattern, the parsed accounts, SOL deltas, token balance changes, and program list match a block
  explorer, and the expected risk findings fire (e.g., `FULL_TOKEN_ACCOUNT_DRAIN` on a drain).
- **Clear error behavior.** Invalid → 400, not-found → 404, RPC failure → 502, each with an
  actionable message surfaced in the UI (matches §5).
- **Determinism.** Re-running the same signature yields an identical `risk.score`, `risk.level`, and
  `findings` set.
- **Explainability.** Every risk finding carries a human-readable `title`, `detail`, and (where
  applicable) `evidence`; the explanation reads as plain English with explicit caveats.
- **Time-to-understanding.** A user can paste a signature and reach a confident read of "what this
  transaction did and whether it looks risky" in seconds, with no on-chain action taken.
- **Agent-ready surface.** The end-to-end review is reachable as a single function
  (`reviewTransaction`) and a single endpoint (`POST /api/review`), demonstrating the explainable
  base a real agent can plug into.

---

## Toolchain

- **Runtime:** Node.js 24.16.0 LTS, npm 11.16.0
- **Framework:** Next.js 16.2.7 (App Router) + React 19.2.7 + TypeScript 6.0.3
- **Styling:** Tailwind CSS 4.3.0 (CSS-first: `@import "tailwindcss"` + `@tailwindcss/postcss`; **no** `tailwind.config.js`)
- **Solana:** `@solana/web3.js` 1.98.4 (v1 line; v2 lives on as `@solana/kit` 6.x — future option)
- **Also current on the machine (not used by this read-only app):** Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2

---

## Known limitations

- Public RPC endpoints rate-limit and prune old transactions; supply a custom RPC via the UI input or
  the `SOLANA_RPC_URL` env var for reliable results.
- Heuristics are **signals, not verdicts** — a high score is a prompt to look closer, not proof of
  malice; a low score is not a guarantee of safety.
- The `rpcUrl` passthrough means the server fetches a client-supplied URL. It is guarded by
  `assertSafeRpcUrl()` (http(s) only; loopback/private/metadata hosts rejected with a 400); a positive
  host allowlist is the remaining hardening before any production deployment.
- No persistence, and no real LLM yet (placeholder explanations only).

---

## Contact / links

<!-- PLACEHOLDER: add repository URL, demo link, and contact handle before submission. -->

- **Repository:** _TODO_
- **Live demo:** _TODO_
- **Contact:** _TODO_
- **Grant:** Superteam Agentic Engineering Grant (~200 USDG)
