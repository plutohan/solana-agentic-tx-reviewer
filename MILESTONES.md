# Milestones & Delivery Plan

**Project:** Solana Agentic Transaction Reviewer
**Grant:** Superteam Agentic Engineering Grant (~200 USDG)
**Status:** Proof-of-concept (PoC) complete — see [M0](#m0--proof-of-concept-done) below.
**Scope discipline:** read-only analysis only. No new protocol. No signing or sending of transactions.

This document is the delivery plan for the grant. It states honestly what exists today, then lays out an incremental roadmap (M1–M4) with deliverables, effort, and acceptance criteria, followed by a timeline, a budget mapping appropriate to a micro-grant, and a risk register.

---

## 1. Current Status — what is done today

The PoC is a working Next.js (App Router) web app. A user pastes a transaction signature; the app fetches the transaction read-only over Solana RPC, normalizes it into a shared data model, runs deterministic risk heuristics, and renders a human-readable explanation plus a risk report.

The full pipeline is live end-to-end:

```
RPC fetch → parse() → assessRisk() → explainTransaction() → ReviewResult (returned by POST /api/review)
```

### What actually works

- **Read-only RPC layer** (`src/lib/solana.ts`): the app only ever calls `getParsedTransaction` (with `maxSupportedTransactionVersion: 0`, `commitment: "confirmed"`). There is no code path that signs or submits anything. `resolveRpcUrl()` picks an endpoint with the precedence `request.rpcUrl > SOLANA_RPC_URL (mainnet only) > public cluster default`, and `isValidSignature()` does cheap base58 structural validation before any network call.
- **Deterministic extraction** (`src/lib/parse.ts`): `parseTransaction(raw, signature, cluster)` normalizes the raw RPC response into the `ParsedTransaction` model. It computes per-account SOL deltas (post − pre balances), SPL token balance changes (from `pre`/`postTokenBalances`), flattens top-level **and** inner (CPI) instructions into one list, and aggregates `programsInvoked` with counts. Everything downstream reads only this normalized shape, never the raw RPC types.
- **Shared data model / contract** (`src/lib/types.ts`): `ReviewRequest`, `AccountSummary`, `InstructionSummary`, `TokenBalanceChange`, `ProgramInvocation`, `ParsedTransaction`, `RiskLevel`, `RiskFinding`, `RiskReport`, `AiExplanation`, and `ReviewResult`. The UI, the API, the risk engine, and the (future) LLM all speak this one contract.
- **Program registry** (`src/lib/programs.ts`): a small curated map of well-known program IDs → `{ name, category }`, covering System, SPL Token, SPL Token-2022, Associated Token Account, Compute Budget, Memo (v1 + current), BPF loaders, Stake, Vote, Metaplex Token Metadata, Jupiter Aggregator v6, Raydium AMM v4, Orca Whirlpools, and pump.fun. Exposes `resolveProgram()` and `isKnownProgram()`.
- **Deterministic risk engine** (`src/lib/heuristics.ts`): 16 pure-function rules that emit explainable `RiskFinding`s with evidence. Score and level aggregation are deterministic (details in [§2 M0](#m0--proof-of-concept-done) and the rules table below). These are explicitly **signals, not a verdict**.
- **AI explanation seam** (`src/lib/ai.ts`): `explainTransaction(tx, risk)` returns a deterministic, template-based natural-language summary today (`provider: "placeholder"`), so the PoC runs with **zero API keys and zero cost**. `buildPrompt(tx, risk)` already produces the exact structured context a real LLM would receive, and the provider switch (`placeholder | openai | anthropic`, gated by the `AI_PROVIDER` env var) shows precisely where a real call slots in. When `openai`/`anthropic` is selected but no key is wired, it deliberately falls through to the placeholder so the app always works.
- **Orchestration + API** (`src/lib/review.ts`, `src/app/api/review/route.ts`): `reviewTransaction(request)` runs the pipeline and throws a typed `ReviewError(status)` for clean HTTP mapping (400 invalid signature, 404 not found, 502 RPC error, 500 unexpected). `POST /api/review` runs on the Node.js runtime (`@solana/web3.js` needs Node APIs).
- **UI** (`src/app/page.tsx`, `src/components/ResultView.tsx`, `src/components/RiskBadge.tsx`): a client form for signature input, cluster select, and an optional custom RPC URL, rendering the parsed transaction, risk findings, and explanation.

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

The broader Solana dev toolchain on the machine is also current — Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2 — though **none of these are used by this read-only web app**; the environment was simply brought up to date.

### Honest limitations (today)

- **The AI is a deterministic placeholder.** No LLM is called yet. The summary is rule-based text; the real-provider hook is stubbed but not wired.
- **Heuristics are signals, not verdicts.** "Unrecognized" does not mean "malicious," and a clean report is not a safety guarantee.
- **Public RPC rate-limits and prunes old transactions.** A custom RPC URL (per request or via `SOLANA_RPC_URL`) is supported to work around this.
- **The `rpcUrl` passthrough lets the server fetch a client-supplied URL.** A baseline SSRF guard (`assertSafeRpcUrl`) ships today (http(s) only; loopback/private/metadata hosts rejected); a positive host allowlist remains for production.
- **No persistence, no auth, no real-LLM integration yet.**

---

## 2. Milestones

Effort estimates assume one part-time engineer. They are deliberately modest and incremental; each milestone ships independently and builds on the existing contract in `src/lib/types.ts`.

### M0 — Proof-of-Concept (DONE)

The read-only reviewer described in [§1](#1-current-status--what-is-done-today). This reflects exactly what exists in the repository today.

**Deliverables (shipped)**
- End-to-end pipeline: RPC fetch → parse → risk → explain → `ReviewResult` via `POST /api/review`.
- Deterministic extraction with SOL deltas, token balance changes, and flattened top-level + inner (CPI) instructions.
- 16 deterministic risk heuristics with scoring and an explanation placeholder that needs no keys.
- Web UI with signature input, cluster select, and optional custom RPC.
- Current toolchain (Node 24 / Next 16 / React 19 / TS 6 / Tailwind 4 / web3.js 1.98.4).

**Risk scoring (as implemented in `src/lib/heuristics.ts`)**
- `LEVEL_WEIGHT`: `info = 0`, `low = 10`, `medium = 25`, `high = 45`.
- **Score** = `clamp(sum of finding weights, 0, 100)`.
- **Overall level** = the **maximum** individual finding level.
- `THRESHOLDS`: `largeSolOutflow = 1` SOL, `veryLargeSolOutflow = 10` SOL, `manyWritableAccounts = 12`, `highFeeSol = 0.01` SOL, `largeTokenOutflowPct = 0.5` (fraction of pre-balance).

| Rule ID | Level | Trigger |
| --- | --- | --- |
| `TX_FAILED` | info | `meta.err != null` (transaction failed on-chain) |
| `UNKNOWN_PROGRAM` | medium | invokes a program not in the registry |
| `LARGE_SOL_OUTFLOW` | medium (≥ 1 SOL) / high (≥ 10 SOL) | fee payer net SOL decrease |
| `FULL_TOKEN_ACCOUNT_DRAIN` | high | token account pre > 0 and post == 0 |
| `LARGE_TOKEN_OUTFLOW` | low (≥ 50% of balance) / medium (≥ 90%) | partial token decrease |
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

**Acceptance criteria (met)**
- Pasting a real mainnet signature returns a parsed transaction, a risk report, and a readable explanation with no API keys configured.
- Invalid signatures, not-found transactions, and RPC failures return the correct HTTP status via `ReviewError`.
- The full chain runs entirely read-only — no signing or sending code exists.

---

### M1 — Real LLM explanation

Connect the existing AI seam to a real provider so the natural-language explanation is genuinely model-generated, while keeping the deterministic placeholder as the default and fallback.

**Deliverables**
- Implement the provider call inside `explainTransaction()` for `openai` and `anthropic`, driven by `buildPrompt(tx, risk)` (already written).
- Gate strictly on `AI_PROVIDER` + the relevant API key; fall back to the placeholder when no key is present (preserving zero-cost operation).
- Map LLM output into the existing `AiExplanation` shape (`summary`, `bullets`, `caveats`, `model`, `generatedAt`) — **no schema changes**.
- Guardrails: a strict "use only the provided facts — never invent addresses, amounts, or intent" system instruction (already in the prompt), output-length caps, basic cost/timeout limits, and a graceful fallback to the placeholder on any provider error.
- Docs: environment setup (`.env.example` keys), provider selection, and a note on cost.

**Effort / time:** ~3–5 days.

**Acceptance criteria**
- With `AI_PROVIDER=openai|anthropic` and a valid key, `provider` in the response reflects the real provider and `model` is populated.
- With no key set, behavior is identical to M0 (placeholder, no network call to any LLM).
- The explanation never asserts an address/amount not present in the `ParsedTransaction`/`RiskReport` it was given.
- A provider timeout or error degrades gracefully to the placeholder rather than failing the request.

---

### M2 — Richer parsing & metadata enrichment

Make the extracted data more legible: resolve programs via on-chain/IDL hints and decorate token movements with mint metadata, so both the heuristics and the explanation have more context.

**Deliverables**
- **Program/IDL enrichment:** expand the `programs.ts` registry and attempt best-effort decoding/labeling of instructions for known programs that arrive only partially decoded; surface friendlier `parsedType` and account roles in `InstructionSummary`.
- **Mint metadata enrichment:** for each `TokenBalanceChange`, resolve symbol/name/decimals/logo (e.g. via Token Metadata / a token list) so the UI shows "−1,250 USDC" instead of a raw mint and base-unit delta.
- **CPI depth & call-tree view:** present the flattened top-level + inner instruction list as a readable nested tree (the data already distinguishes inner instructions and parent indices).
- Caching/memoization for metadata lookups to limit extra RPC/HTTP calls.

**Effort / time:** ~1–1.5 weeks.

**Acceptance criteria**
- Token changes render with human-readable symbols and amounts where metadata is available, and degrade cleanly (raw mint) where it is not.
- Previously "unrecognized" but well-known instructions are labeled, reducing false `UNKNOWN_PROGRAM` noise.
- Inner/CPI instructions are visibly grouped under their parent in the UI.
- Enrichment is additive: the `ParsedTransaction` contract still validates and all M0/M1 behavior is unchanged when metadata lookups fail.

---

### M3 — Expanded heuristics + known-scam / drainer lists

Increase detection coverage and precision, adding curated threat intelligence so the tool catches more real-world drainer and scam patterns.

**Deliverables**
- New/refined rules (examples): suspicious destination concentration, multi-step drain sequences (approve → transfer → close in one tx), token-2022 transfer-hook / extension red flags, dust/poisoning-style transfers, and tightened SOL/token outflow logic.
- **Known-scam / drainer address lists:** integrate one or more curated allow/deny lists (with provenance and a clear "signal, not verdict" disclaimer); flag interactions with flagged addresses as a finding with evidence.
- A simple way to keep lists fresh (versioned data file or scheduled fetch) plus per-finding source attribution.
- Calibration pass on `THRESHOLDS` and `LEVEL_WEIGHT` against a small fixture set of real transactions to manage false positives.

**Effort / time:** ~1–2 weeks.

**Acceptance criteria**
- New rules fire correctly on curated fixtures and do not regress the M0 rule outputs on existing fixtures.
- Interactions with addresses on the deny list produce a clear, sourced finding.
- Every finding still carries human-readable evidence and an explicit disclaimer that heuristics are signals, not a guarantee.
- Documented provenance for any third-party list, including update cadence.

---

### M4 — Agentic mode + hardening

Move from "review after the fact" to "review **before** signing," and harden the service for shared/production use.

**Deliverables**
- **Pre-sign simulation:** accept an unsigned/serialized transaction (not just a confirmed signature), run it through `simulateTransaction` (read-only), and feed the simulated balance/account changes through the same parse → risk → explain pipeline.
- **Agent / integration surface:** a clean programmatic API (and/or a wallet-extension hook or a standardized agent tool interface) so a wallet or autonomous agent can request a review and receive the structured `ReviewResult` before approving a signature.
- **Hardening:** extend the existing baseline `rpcUrl` SSRF guard to a positive host allowlist, add rate limiting and input limits, and add structured logging/observability.
- **Persistence:** optional storage of reviews for history, sharing, and de-duplication.
- Consider migrating the RPC layer to `@solana/kit` (web3.js v2 line) as part of this hardening, if it materially improves bundle size or ergonomics.

**Effort / time:** ~2–3 weeks.

**Acceptance criteria**
- A user/agent can submit a transaction **prior to signing** and receive a risk report and explanation derived from simulation, fully read-only.
- The `rpcUrl` passthrough is constrained to a vetted allowlist (or disabled) in the hardened configuration; SSRF vectors are closed.
- Rate limiting and persistence are in place and documented; the service is safe to expose beyond localhost.
- Still no code path signs or submits a transaction on the user's behalf — the tool advises, the human/agent decides.

---

## 3. Timeline & budget mapping

A micro-grant funds a focused first increment, not the whole roadmap. The plan below keeps the funded scope small and credible; M2–M4 are presented as the natural follow-on path beyond the grant.

### Timeline (weeks)

| Week | Focus | Milestone |
| --- | --- | --- |
| 0 | — | **M0 already delivered** (this PoC) |
| 1 | Wire OpenAI/Anthropic through the existing seam; guardrails; docs | **M1** |
| 2–3 | Mint + program/IDL enrichment; CPI tree view | **M2** (stretch within grant) |
| 4–5 | Expanded heuristics + scam/drainer lists | **M3** (post-grant) |
| 6–8 | Pre-sign simulation, agent surface, hardening, persistence | **M4** (post-grant) |

### Budget / scope mapping (~200 USDG)

A ~200 USDG award is treated as a focused bounty, not a salary. The funded commitment is intentionally modest:

| Item | Scope | Indicative share |
| --- | --- | --- |
| **M1 — Real LLM explanation** | Connect the stubbed provider seam, guardrails, fallback, docs | Primary funded deliverable |
| **M2 (partial) — Enrichment** | Mint metadata + program labeling as a stretch goal | Secondary, if time allows |
| LLM API usage during development | Capped/budgeted test calls; placeholder keeps day-to-day cost at zero | Minor |
| Documentation & demo | README, demo video/GIF, `.env.example` | Included |

M3 and M4 are scoped here so reviewers can see the full vision, but they are **not** promised under the micro-grant; they would be pursued as follow-on work or under a larger grant. This keeps the commitment honest and achievable.

---

## 4. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Public RPC rate-limits / prunes old transactions** | High | Medium | Custom RPC supported per-request and via `SOLANA_RPC_URL`; document recommended providers; add caching in M2. |
| **LLM hallucination** (invents addresses/amounts/intent) | Medium | High | Strict "use only provided facts" system prompt (already in `buildPrompt`); deterministic risk score is the source of truth; explanation is framed as advisory with caveats; placeholder fallback. |
| **Over-trust in heuristics** (users read "low risk" as "safe") | Medium | High | Consistent "signals, not a verdict / not financial advice" disclaimers in `caveats` and UI; encourage verification on a trusted explorer. |
| **False positives** (e.g. legitimate large transfers, unknown-but-safe programs) | Medium | Medium | Tunable `THRESHOLDS`; registry expansion + IDL labeling in M2; threshold calibration against fixtures in M3. |
| **SSRF via client-supplied `rpcUrl`** | Low (local PoC) → High (if exposed) | High | Baseline guard `assertSafeRpcUrl` already blocks loopback/private/metadata hosts (http(s) only, 400 on violation); M4 adds a positive host allowlist + rate limiting before any public deployment. |
| **LLM API cost overruns** | Low | Medium | Placeholder is the default (zero cost); real provider gated behind `AI_PROVIDER` + key; length/timeout caps; capped dev budget. |
| **Upstream breakage** (web3.js v1 EOL, RPC API drift) | Low | Medium | Pinned versions; `@solana/kit` (v2) noted as a migration path; thin, well-isolated RPC layer (`src/lib/solana.ts`) makes swapping cheap. |
| **Scope creep beyond a micro-grant** | Medium | Medium | M1 is the only firmly funded deliverable; M2–M4 explicitly marked as stretch/post-grant. |

---

## Contact & links

<!-- PLACEHOLDER: add repository URL, live demo URL, demo video, and contact (e.g. Superteam handle / email) before submission. -->

- **Repository:** _TODO_
- **Live demo:** _TODO_
- **Demo video:** _TODO_
- **Contact:** _TODO_

---

*This is a read-only proof-of-concept. The tool analyzes and explains transactions; it never signs or sends them. Risk heuristics are best-effort signals, not a security guarantee or financial advice — always verify on a trusted block explorer before acting.*
