# MVP Scope: Solana Agentic Transaction Reviewer

> A lightweight, AI-assisted, **read-only** Solana transaction reviewer. Paste a confirmed
> signature, or paste an unsigned transaction to simulate before you sign. You get a
> plain-English explanation plus a deterministic risk report. Nothing is ever signed or sent.

This document defines the scope of the proof-of-concept (PoC) MVP I built for the
**Superteam Agentic Engineering Grant** (~200 USDG). It is intentionally narrow. Every claim
below is tied to code that actually exists in this repository.

| | |
| --- | --- |
| **Status** | Proof-of-concept (PoC) |
| **Mode** | Read-only analysis. No signing, no sending, no state changes. |
| **Audience** | Solana users and developers who want to understand and sanity-check a transaction before or after signing |
| **AI today** | Deterministic template explanation (`provider: "placeholder"`) with a real LLM seam wired in. Zero API keys, zero cost by default. |

---

## 1. Problem statement

Solana transactions are fast and cheap. They are also opaque. A base58 signature on a block
explorer expands into a wall of accounts, raw instructions, inner CPIs, and pre/post balance
arrays that are hard for a human to read quickly. Users routinely sign transactions, or review
them after the fact, without a clear, plain-English picture of what moved, who gained authority,
which programs were touched, or whether the pattern looks like a drain. That gap is exactly where
people lose funds. Delegate approvals, authority handovers, and full token-account drains all hide
in that wall of data. It is also where developers waste time debugging. This project closes the gap
with a focused tool that turns a raw signature (or an unsigned transaction) into a normalized,
human-readable explanation plus an explainable, deterministic risk report. It is a base that a real
agent can later plug into.

---

## 2. MVP goal and non-goals

### Goal

Ship a working web app where a user either pastes a confirmed Solana transaction signature **or**
pastes an unsigned (base64) transaction to review **before** signing, selects a cluster
(optionally supplying a custom RPC), and receives:

1. A **normalized view** of the transaction. Metadata, accounts with net SOL deltas, flattened
   top-level + inner (CPI) instructions, SPL token balance changes (with token symbols and logos),
   and aggregated program invocations. The confirmed path is `parseTransaction` in `src/lib/parse.ts`.
   The pre-sign path is `simulateAndReview` in `src/lib/presign.ts`, and both emit the same
   `ParsedTransaction`.
2. A **deterministic risk report**. A 0-100 score, an overall level, and individual findings with
   human-readable evidence (`assessRisk` in `src/lib/heuristics.ts`).
3. A **plain-English explanation**. A narrative summary, key-action bullets, and caveats
   (`explainTransaction` in `src/lib/ai.ts`). For the pre-sign path it is framed as a read-only
   simulation of an unsigned transaction.

The whole pipeline is a single call, `reviewTransaction(request)` in `src/lib/review.ts`, exposed
over `POST /api/review` (`src/app/api/review/route.ts`) and rendered by the client UI
(`src/app/page.tsx` then `src/components/ResultView.tsx`).

### Non-goals (explicit)

The MVP **does not**, by design:

- **No new protocol, no on-chain program.** This is a web app that reads and simulates existing
  transactions. (My broader Solana toolchain, Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2, is
  current but **not used** by this read-only app.)
- **No signing or sending.** The tool never builds, signs, or broadcasts a transaction. The pre-sign
  path simulates only: it calls `simulateTransaction` with `sigVerify: false` and a replaced
  blockhash, and nothing it produces is ever submitted. The confirmed path only calls read RPC
  methods (`getParsedTransaction`).
- **No persistence.** No database, no accounts, no stored history. Every review is computed on
  demand and returned in the response. (A confirmed review does expose a shareable permalink that
  re-fetches on demand.)
- **No real LLM by default.** The AI layer returns a deterministic, template-generated explanation
  (`AiExplanation.provider === "placeholder"`). The real provider switch is wired in and ready: set
  `AI_PROVIDER` plus an API key to turn it on. See §3 and the AI Layer note below.
- **No wallet connection, no portfolio/price data.**

---

## 3. In-scope features vs. roadmap

### In scope (this MVP, shipped)

| Feature | What it does | Where it lives |
| --- | --- | --- |
| Signature input + cluster select | Paste a base58 signature. Choose `mainnet-beta` / `devnet` / `testnet`, with an optional custom RPC override. | `src/app/page.tsx` |
| **Pre-sign simulation** | Paste a base64-serialized **unsigned** `VersionedTransaction` and review it before approving. Deserialize it, resolve any v0 address lookup tables, simulate read-only (`sigVerify:false`, `replaceRecentBlockhash:true`, `innerInstructions:true`, `accounts` requested for the writable set), then derive SOL and SPL token deltas by diffing pre-state (`getMultipleAccountsInfo`) against the simulated post-state. A small discriminator decoder recovers SPL Token + System instruction TYPES from raw data, so the same `parsedType`-dependent heuristics fire. Emits the SAME `ParsedTransaction` (with `simulated:true`). Nothing is signed or sent. | `simulateAndReview` in `src/lib/presign.ts` |
| **Token metadata enrichment** | Resolves mint to `{ symbol, name, logoURI }` via a small known-token registry (SOL/USDC/USDT/BONK/JUP/WIF/JTO) plus a cached, best-effort Jupiter datapi lookup, with graceful fallback to the raw mint. Runs for BOTH paths and never throws. | `enrichTokenMetadata` in `src/lib/metadata.ts` |
| `POST /api/review` endpoint | Node.js-runtime route that accepts `{ signature, cluster?, rpcUrl? }` **or** `{ rawTransaction, cluster?, rpcUrl? }` (exactly one of `signature` / `rawTransaction`) and returns a `ReviewResult` | `src/app/api/review/route.ts` |
| Signature validation | Rejects malformed input before any RPC call (86-88 char base58) | `isValidSignature` in `src/lib/solana.ts`, enforced in `src/lib/review.ts` |
| RPC resolution + fetch | Resolves endpoint (`rpcUrl` > `SOLANA_RPC_URL` env > public default) and fetches with `maxSupportedTransactionVersion: 0` | `resolveRpcUrl`, `getConnection`, `fetchParsedTransaction` in `src/lib/solana.ts` |
| Deterministic parsing | Normalizes the raw RPC response into `ParsedTransaction`: SOL deltas (post minus pre), token balance changes (pre/postTokenBalances), flattened top-level + inner CPI instructions, aggregated `programsInvoked`, fee payer, signers, writable accounts | `parseTransaction` in `src/lib/parse.ts` |
| Known-program registry | Resolves program IDs to `{ name, category }` and flags unknown programs | `resolveProgram` / `isKnownProgram` in `src/lib/programs.ts` |
| Deterministic risk heuristics | Explainable rules to `RiskReport` (`score`, `level`, `findings[]`, `summary`), including a curated address/program watchlist | `assessRisk` in `src/lib/heuristics.ts` (detailed in §"Risk heuristics") |
| Placeholder AI explanation + LLM seam | Template narrative + bullets + caveats with `provider: "placeholder"`. `buildPrompt(tx, risk)` returns the exact context a real LLM receives, and the OpenAI/Anthropic provider switch is wired in (gated by `AI_PROVIDER` + key). The simulated path is framed as read-only. | `explainTransaction`, `buildPrompt` in `src/lib/ai.ts` |
| Result rendering | Presentational view of transaction, risk, and explanation, with a risk badge, token symbols, a "SIMULATED" badge, and "Would succeed / Would fail" for the pre-sign path | `src/components/ResultView.tsx`, `src/components/RiskBadge.tsx` |
| Typed error handling | `ReviewError(status)` maps failures to clear HTTP codes (400 / 404 / 500 / 502) surfaced in the UI | `src/lib/review.ts`, consumed by `src/app/page.tsx` |
| Custom RPC override | UI toggle ("+ custom RPC") and `rpcUrl` passthrough to avoid public-RPC rate limits / pruning | `src/app/page.tsx`, `src/lib/solana.ts` |

### Roadmap (next milestones, agent-paced in days)

M1 (pre-sign simulation) is **done and shipped**. Token metadata enrichment is **done and shipped**.
These were the previous "next" items. The remaining work, in rough order:

| Milestone | What it adds | Rough estimate |
| --- | --- | --- |
| **Deepen LLM guardrails** | Turn the wired-in OpenAI/Anthropic path on by default behind a budget, add strict output validation, prompt-injection resistance against on-chain log/memo text, and a fallback contract so a bad model response never degrades the deterministic facts. | ~2-3 days |
| **Richer program/IDL labeling + CPI tree view** | Resolve more program IDs to friendly names, decode more instruction types via on-chain IDLs (today the pre-sign decoder covers SPL Token + System), and render the instruction list as a real CPI tree instead of a flat list. | ~3-4 days |
| **Expanded heuristics + watchlist growth + hardening** | More rules, configurable `THRESHOLDS`, mint/price-aware outflow valuation, more curated (citable) watchlist entries, plus a positive RPC host allowlist and rate limiting before any production deployment. | ~3-5 days |
| **Migration to `@solana/web3.js` v2** | Today uses `@solana/web3.js` 1.98.4 (the v1 line). v2 lives on as `@solana/kit` 6.x. A future option, not yet started. | TBD |
| **Agent integration** | Expose `reviewTransaction()` as a tool other agents call. The pipeline is already a single function, so this is mostly packaging. | ~1-2 days |

---

## 4. Primary user stories

- **As a Solana user**, I paste a transaction signature and get a plain-English explanation plus
  risk flags, so I can sanity-check what a transaction did without decoding raw instructions myself.
- **As a Solana user about to sign**, I paste an unsigned (base64) transaction and see what it
  *would* do, simulated read-only, before I approve it. If it sends funds to a burn address or asks
  for a delegate approval, I see that flagged **before** signing.
- **As a Solana user worried about scams**, I want full token-account drains, delegate approvals,
  authority handovers, and flagged-address hits surfaced as **high/medium** findings with evidence,
  so I can spot a drain-pattern transaction at a glance.
- **As a Solana developer debugging a failed transaction**, I paste the signature and see
  `success: false`, the decoded error, the flattened instruction list (including inner CPIs), and
  the program invocation counts, so I can pinpoint what broke faster than scrolling raw logs.
- **As a developer integrating an unfamiliar protocol**, I want any program **not** in the known
  registry flagged (`UNKNOWN_PROGRAM`), so I know to independently verify what I'm calling.
- **As a user on a rate-limited public RPC**, I want to supply my own RPC URL (Helius/QuickNode/etc.)
  via the UI or `SOLANA_RPC_URL`, so I can reliably review older or high-volume transactions, and so
  pre-sign simulation with account state works (public RPC rate-limits simulate-with-accounts).
- **As a future agent builder**, I want one deterministic function (`reviewTransaction`) that turns a
  signature or an unsigned transaction into a structured `ReviewResult`, so I can plug transaction
  review into an automated flow.

---

## 5. Acceptance criteria

These are concrete and testable against the real pipeline
(`reviewTransaction` then `POST /api/review`).

**Input validation**

- [ ] A request with a **missing or malformed** signature (not an 86-88 char base58 string) and no
      `rawTransaction` returns **HTTP 400** with the message
      `Invalid transaction signature. Expected an 86–88 character base58 string.`
      and performs **no RPC call** (`isValidSignature` gate in `src/lib/review.ts`).
- [ ] A request with a `rawTransaction` that is not decodable base64 returns **HTTP 400** with a
      message asking for a base64-serialized (unsigned) Solana transaction (`PresignError`).
- [ ] The signature is trimmed and `cluster` defaults to `mainnet-beta` when omitted.

**Fetch / not-found / RPC errors**

- [ ] A **valid but non-existent** signature (pruned, wrong cluster, or unconfirmed) returns
      **HTTP 404** with
      `Transaction not found. It may be too old for this RPC, on a different cluster, or not yet confirmed.`
- [ ] An **RPC failure** on the confirmed path returns **HTTP 502** with a message prefixed
      `RPC error while fetching the transaction:` (`ReviewError(..., 502)`).
- [ ] A custom `rpcUrl` supplied in the request body is used for both paths. Otherwise resolution
      falls back to `SOLANA_RPC_URL` and then the public default (`resolveRpcUrl`).

**Successful review (the happy path)**

- [ ] A **valid, existing** signature returns **HTTP 200** with a `ReviewResult` containing
      `request`, `transaction`, `risk`, and `explanation`.
- [ ] A valid `rawTransaction` returns **HTTP 200** with the same `ReviewResult` shape, where
      `transaction.simulated === true`, `transaction.signature === "(unsigned)"`, and the fee is
      reported as not-applicable.
- [ ] `transaction` (a `ParsedTransaction`) includes: `signature`, `cluster`, `slot`, `blockTime`,
      `success`, `err`, `feeLamports`/`feeSol`, `feePayer`, `accounts[]`, `signers[]`,
      `writableAccounts[]`, `instructions[]`, `tokenBalanceChanges[]`, `programsInvoked[]`, and
      `version`.
- [ ] Each account in `accounts[]` carries a net SOL delta (`solChangeLamports` = post minus pre,
      and `solChangeSol`), and `accounts[0].pubkey` is reported as `feePayer`.
- [ ] `instructions[]` contains **both** top-level and inner (CPI) instructions, flattened with a
      sequential `index`. Inner instructions have `isInner: true` and a `parentIndex`.
- [ ] `tokenBalanceChanges[]` lists only accounts whose raw token amount changed, sorted by absolute
      `delta`, each with `mint`, `decimals`, pre/post raw + UI amounts, `delta`, and (when resolved) a
      `symbol`, `name`, and `logoURI`.
- [ ] `programsInvoked[]` aggregates program-ID counts across top-level + inner instructions, sorted
      by count, with a friendly `name` when the program is in the registry.

**Risk report**

- [ ] `risk` (a `RiskReport`) returns a numeric `score` in **0-100**, an overall `level`, a
      `findings[]` array, and a one-line `summary`.
- [ ] `score` equals the clamped sum of finding weights (`info=0, low=10, medium=25, high=45`),
      capped at 100. The overall `level` equals the **maximum** individual finding level.
- [ ] A transaction with **no triggered rules** returns `level: "info"`, `score: 0`, and summary
      `No notable risk signals were detected by the deterministic heuristics.`
- [ ] A transaction whose `meta.err != null` produces a `TX_FAILED` (`info`) finding and
      `transaction.success === false`.
- [ ] A transaction that **fully drains** a token account (pre > 0, post == 0) produces a
      `FULL_TOKEN_ACCOUNT_DRAIN` (`high`) finding, pushing overall `level` to `high`.
- [ ] An **unsigned** transfer to the burn/incinerator address, run through the pre-sign path, fires
      the `FLAGGED_ADDRESS` watchlist finding **before** signing.
- [ ] Findings are **deterministic**: the same input transaction always yields the same `score`,
      `level`, and `findings` (no randomness, no network in `assessRisk`).

**Explanation**

- [ ] By default, `explanation` (an `AiExplanation`) has `provider: "placeholder"`, a non-empty
      `summary`, `bullets[]`, `caveats[]`, and a `generatedAt` timestamp, and requires **no API key**.
- [ ] For a simulated transaction, the explanation is framed as
      "This is a read-only simulation of an unsigned transaction. If signed and sent now, it would...".

**UI**

- [ ] The client (`src/app/page.tsx`) offers a "Confirmed signature" / "Unsigned tx (pre-sign)"
      toggle, disables **Review** while a request is in flight or the active input is empty, renders a
      clear error banner on non-2xx responses, and renders the `ResultView` on success.
- [ ] `ResultView` shows token symbols, a "SIMULATED" badge, and "Would succeed / Would fail" for the
      pre-sign path. The shareable permalink is shown only for confirmed reviews.
- [ ] The UI states plainly that the tool is read-only ("Read-only. Nothing is signed or sent.").

---

## Risk heuristics (reference)

Deterministic, explainable signals. **Not** a verdict. Defined in `src/lib/heuristics.ts`.

- **Score:** `clamp(sum of level weights, 0, 100)` with `LEVEL_WEIGHT = { info: 0, low: 10, medium: 25, high: 45 }`.
- **Overall level:** the **maximum** individual finding level.
- **Thresholds (`THRESHOLDS`):** `largeSolOutflow = 1 SOL`, `veryLargeSolOutflow = 10 SOL`,
  `manyWritableAccounts = 12`, `highFeeSol = 0.01 SOL`, `largeTokenOutflowPct = 0.5`.

| ID | Level | Trigger |
| --- | --- | --- |
| `TX_FAILED` | info | `meta.err != null` |
| `UNKNOWN_PROGRAM` | medium | Invokes a program not in the registry |
| `LARGE_SOL_OUTFLOW` | medium (>=1 SOL) / high (>=10 SOL) | Fee payer net SOL decrease |
| `FULL_TOKEN_ACCOUNT_DRAIN` | high | Token account pre > 0 and post == 0 |
| `LARGE_TOKEN_OUTFLOW` | low (>=50% of balance) / medium (>=90%) | Partial token decrease |
| `SET_AUTHORITY` | high | `spl-token` `setAuthority` |
| `ACCOUNT_REASSIGN` | medium | `system` `assign` |
| `TOKEN_DELEGATE_APPROVE` | medium | `spl-token` `approve` / `approveChecked` |
| `CLOSE_TOKEN_ACCOUNT` | medium | `spl-token` `closeAccount` |
| `PROGRAM_DEPLOY_OR_UPGRADE` | medium | BPF Upgradeable Loader involved |
| `MANY_WRITABLE_ACCOUNTS` | low | Writable count >= 12 |
| `HIGH_FEE` | low | Fee > 0.01 SOL |
| `NEW_ACCOUNT_CREATION` | info | `system` `createAccount` / `createAccountWithSeed` / `allocate` |
| `MULTIPLE_SIGNERS` | info | More than 1 signer |
| `COMPUTE_BUDGET_SET` | info | Compute Budget program used |
| `MEMO_PRESENT` | info | Memo program used |

A curated address/program watchlist (`FLAGGED_ADDRESS`, in `src/lib/watchlist.ts`) also fires when a
flagged address or program appears in the transaction. It is best-effort and non-exhaustive, and
every entry needs a citable public source.

---

## AI layer (reference)

By default, `explainTransaction(tx, risk)` returns a **deterministic template** explanation
(`provider: "placeholder"`), so the PoC runs with **zero keys and zero cost**. `buildPrompt(tx, risk)`
returns the exact context a real LLM receives, and the provider switch in `explainTransaction()` is
wired in: set `AI_PROVIDER=anthropic|openai` plus an API key and a real model is called, with the
deterministic placeholder as a guaranteed fallback on any error. Swapping in a real model does not
change the data contract. It still returns an `AiExplanation`. For a simulated transaction, the prompt
and explanation both make clear this is a read-only, pre-sign simulation.

---

## 6. Success metrics for the PoC

The MVP is considered successful if:

- **It runs with zero secrets.** A fresh clone reviews a real `mainnet-beta` transaction with no API
  keys configured (placeholder AI) and the public default RPC.
- **Correctness on real transactions.** For a hand-picked set of real signatures covering SOL
  transfers, SPL transfers, a swap/DeFi route, a failed transaction, and a known drain/approve
  pattern, the parsed accounts, SOL deltas, token balance changes, and program list match a block
  explorer, and the expected risk findings fire (for example, `FULL_TOKEN_ACCOUNT_DRAIN` on a drain).
- **Pre-sign works against mainnet.** I verified this live. An unsigned transfer to the
  burn/incinerator address simulated successfully, showed SOL deltas of -0.001005 (payer, fee
  included) and +0.001 (burn), and the `FLAGGED_ADDRESS` watchlist rule fired **before** signing.
  Nothing was signed or sent.
- **Clear error behavior.** Invalid goes to 400, not-found to 404, RPC failure to 502, each with an
  actionable message surfaced in the UI (matches §5).
- **Determinism.** Re-running the same signature yields an identical `risk.score`, `risk.level`, and
  `findings` set.
- **Explainability.** Every risk finding carries a human-readable `title`, `detail`, and (where
  applicable) `evidence`. The explanation reads as plain English with explicit caveats.
- **Time-to-understanding.** A user can paste a signature (or an unsigned transaction) and reach a
  confident read of "what this transaction did, or would do, and whether it looks risky" in seconds,
  with no on-chain action taken.
- **Agent-ready surface.** The end-to-end review is reachable as a single function
  (`reviewTransaction`) and a single endpoint (`POST /api/review`), so a real agent has a clean
  explainable surface to plug into.

---

## Toolchain

- **Runtime:** Node.js 24.16.0 LTS, npm 11.16.0
- **Framework:** Next.js 16.2.7 (App Router) + React 19.2.7 + TypeScript 6.0.3
- **Styling:** Tailwind CSS 4.3.0 (CSS-first: `@import "tailwindcss"` + `@tailwindcss/postcss`, **no** `tailwind.config.js`)
- **Solana:** `@solana/web3.js` 1.98.4 (v1 line. v2 lives on as `@solana/kit` 6.x, a future option.)
- **Also current on the machine (not used by this read-only app):** Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2

---

## Tests

- `npm test` runs the **24 deterministic checks (10 heuristics plus 14 pure-helper checks)** (all passing). They need no network and
  no keys.
- Pre-sign simulation and token metadata were verified by **live integration against mainnet**. They
  need an RPC, so they are not in the offline unit suite.

---

## Known limitations

- Public RPC endpoints rate-limit and prune old transactions. Supply a custom RPC via the UI input or
  the `SOLANA_RPC_URL` env var for reliable results. Pre-sign simulation in particular needs a custom
  RPC, because public RPC rate-limits simulate-with-accounts.
- For the pre-sign path, the **fee is not computed during simulation** (it is shown as
  not-applicable). The instruction-type decoder covers **SPL Token + System** only. Other programs'
  instruction types are not decoded, though balance, program, and watchlist heuristics still apply.
  Because the blockhash is replaced, the real result after signing can differ if on-chain state
  changes before you submit.
- Heuristics are **signals, not verdicts**. A high score is a prompt to look closer, not proof of
  malice. A low score is not a guarantee of safety.
- The `rpcUrl` passthrough means the server fetches a client-supplied URL. It is guarded by
  `assertSafeRpcUrl()` (http(s) only, loopback/private/metadata hosts rejected with a 400). A positive
  host allowlist is the remaining hardening before any production deployment.
- No persistence, and no real LLM by default (placeholder explanations unless `AI_PROVIDER` + a key
  are set).

---

## Contact / links

- **Repository:** https://github.com/plutohan/solana-agentic-tx-reviewer
- **Live demo:** _TODO_
- **Contact:** _TODO_
- **Grant:** Superteam Agentic Engineering Grant (~200 USDG)
</content>
</invoke>
