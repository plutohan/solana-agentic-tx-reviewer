# Solana Agentic Transaction Reviewer

A small, AI-assisted, **read-only** tool for understanding Solana transactions. You paste a transaction signature. The app fetches it over Solana RPC, pulls out the metadata, accounts, instructions (including inner/CPI calls), and token balance changes, runs a set of deterministic risk heuristics, and writes a plain-English explanation next to a structured risk report.

I built it for Solana users and developers who want to **sanity-check a transaction before or after signing**. It catches wallet drains, surprise delegate approvals, authority handovers, and calls into programs nobody recognizes, and it helps you debug what a transaction actually did.

> **Read-only. Nothing is ever signed or sent.** This tool only reads a transaction that already exists on-chain. It holds no keys, never constructs or submits transactions, and never asks for a wallet connection. The only thing it can do is *read* and *explain*.

> **Built with agents.** I scaffolded, documented, and adversarially reviewed this project with a multi-agent workflow. Agents brought the toolchain current (Node 24, Rust 1.96, Agave 4.0.1, Anchor 1.0.2). A research-agent discovery pass confirmed the program IDs. The heuristics were de-risked agent-by-agent against routine swaps and real drains.

This is a deliberately small proof-of-concept built for the **Superteam Agentic Engineering micro-grant** (~200 USDG, Solana Earn). There is no new on-chain protocol, no signing, and no persistence. It is just an explainable analysis pipeline that a real agent could plug into.

### Why this matters for Solana's agentic future

Think of the reviewer as the review step an agent runs before it signs. An agent proposes a transaction, the reviewer judges it (**parse → heuristics → explanation**), and a human or agent approves. As autonomous agents start moving value on Solana, a deterministic, auditable "second opinion" between *proposed* and *signed* is exactly the missing piece. That is the headline reason I built this PoC the way I did.

---

## Features

- **Signature input.** Paste any base58 transaction signature. Structural validation runs before any network call (`isValidSignature` in [`src/lib/solana.ts`](src/lib/solana.ts)).
- **RPC fetch.** Read-only `getParsedTransaction` with `maxSupportedTransactionVersion: 0`, so both legacy and versioned (v0) transactions resolve.
- **Deterministic parsing** ([`src/lib/parse.ts`](src/lib/parse.ts)) normalizes the raw RPC response into a single UI-ready model:
  - accounts with their **signer / writable / program** roles and per-account **net SOL delta** (post − pre balances),
  - **top-level and inner (CPI) instructions** flattened into one ordered list, each tagged with its program and parsed instruction type,
  - **SPL token balance changes** computed from `pre`/`postTokenBalances` (before, after, and delta per token account),
  - **aggregated program invocations** with friendly names and call counts.
- **Deterministic risk report** ([`src/lib/heuristics.ts`](src/lib/heuristics.ts)). Pure, explainable rules (now **18** of them) that surface drains, authority changes, delegate approvals, unknown programs, large outflows, and more, each with a level, a human-readable detail, and supporting evidence.
- **Swap-aware, signer-scoped heuristics.** Drain/outflow rules fire **only on signer-owned token accounts** (pool/vault PDAs that routinely zero out during swaps are ignored), wrapped SOL is excluded from token rules, and a new `TOKEN_SWAP` rule defensively relabels a would-be drain when the **same signer received value back through a known DEX**. This kills the biggest false positive (a routine Jupiter swap previously read HIGH).
- **Known-address watchlist** ([`src/lib/watchlist.ts`](src/lib/watchlist.ts)). A curated, best-effort, non-exhaustive list that raises a `FLAGGED_ADDRESS` finding (seeded honestly with the SOL burn/incinerator address; flagged program IDs are empty by default to avoid false accusations).
- **De-saturated scoring.** `assessRisk` dedups same-id findings and applies **diminishing returns** per level so a routine swap reads LOW while a real, stacked drainer stays HIGH.
- **Real dual-provider LLM behind the seam** ([`src/lib/ai.ts`](src/lib/ai.ts)). The explanation layer genuinely calls **Anthropic or OpenAI** when a key is configured (Anthropic uses prompt caching on the system prompt), with a **free deterministic placeholder default** and graceful fallback on *any* error (missing key, network, rate limit, bad JSON).
- **Shareable permalink** ([`src/app/tx/[signature]/page.tsx`](src/app/tx/%5Bsignature%5D/page.tsx)). `GET /tx/<signature>?cluster=...` server-renders the full review pipeline, and a Next 16 [`ImageResponse`](src/app/tx/%5Bsignature%5D/opengraph-image.tsx) OG card (risk level + score + short signature) makes a pasted link unfurl into a risk preview.
- **`npm test` regression suite** ([`tests/heuristics.test.ts`](tests/heuristics.test.ts)). 10 deterministic checks proving swaps stay LOW, real drains stay HIGH, pool/WSOL noise is filtered, and the watchlist fires.
- **Cluster + custom RPC support.** Switch between `mainnet-beta`, `devnet`, and `testnet`, and optionally supply your own Helius / QuickNode / Triton endpoint to avoid public-RPC rate limits.

---

## Architecture

The pipeline is a single linear flow. The client posts a signature to one API route (or hits the `/tx/<sig>` permalink). That route runs the four library stages in order and returns a `ReviewResult`.

```
                         ┌─────────────────────────────────────────────────────┐
   Browser UI            │                  Next.js (Node runtime)              │
 ┌───────────────┐       │                                                      │
 │  page.tsx     │  POST │  app/api/review/route.ts   (and /tx/[sig] permalink) │
 │  signature ───┼──────►│        │                                             │
 │  cluster      │ /api/ │        ▼                                             │
 │  custom RPC   │review │  lib/review.ts  reviewTransaction(request)           │
 └───────▲───────┘       │        │                                             │
         │               │        ▼                                             │
         │               │   ① fetch ──► lib/solana.ts   getParsedTransaction   │
         │               │        │      (read-only RPC, maxSupportedVersion:0) │
         │  ReviewResult │        ▼                                             │
         │   (JSON)      │   ② parse ──► lib/parse.ts     ParsedTransaction     │
         │               │        │      (SOL deltas, token changes, CPIs)      │
         │               │        ▼                                             │
         │               │   ③ risk  ──► lib/heuristics.ts  RiskReport          │
         │               │        │      (18 rules → deduped, de-saturated)     │
         │               │        ▼                                             │
         │               │   ④ explain ► lib/ai.ts        AiExplanation         │
         │               │        │      (placeholder OR real Anthropic/OpenAI) │
         │               │        ▼                                             │
         └───────────────┼─── ReviewResult ─────────────────────────────────────┘
   components/                 { request, transaction, risk, explanation }
   ResultView.tsx
   RiskBadge.tsx
```

**How files map to the pipeline:**

| Stage | File | Responsibility |
| --- | --- | --- |
| Contract | [`src/lib/types.ts`](src/lib/types.ts) | Shared data model every stage speaks: `ReviewRequest`, `ParsedTransaction`, `RiskReport`, `AiExplanation`, `ReviewResult`, and supporting types. |
| ① Fetch | [`src/lib/solana.ts`](src/lib/solana.ts) | `getConnection`, `resolveRpcUrl`, `assertSafeRpcUrl`, `isValidSignature`, `fetchParsedTransaction`. |
| ② Parse | [`src/lib/parse.ts`](src/lib/parse.ts) | `parseTransaction(raw, signature, cluster)` → `ParsedTransaction`. |
| ③ Risk | [`src/lib/heuristics.ts`](src/lib/heuristics.ts) | `assessRisk(tx)` → `RiskReport` (dedupe + diminishing-returns scoring). |
| ④ Explain | [`src/lib/ai.ts`](src/lib/ai.ts) | `explainTransaction(tx, risk)` + `buildPrompt(tx, risk)` (real LLM or placeholder). |
| Orchestrator | [`src/lib/review.ts`](src/lib/review.ts) | `reviewTransaction(request)` chains all four stages; throws `ReviewError(status)`. |
| Support | [`src/lib/programs.ts`](src/lib/programs.ts) | Registry of known program IDs → `{ name, category }`; `resolveProgram`, `isKnownProgram`, `isDexProgram`, `DEX_PROGRAM_IDS`, `WSOL_MINT`. |
| Support | [`src/lib/watchlist.ts`](src/lib/watchlist.ts) | Curated flagged-address/program list; `lookupWatch(address)`. |
| Support | [`src/lib/format.ts`](src/lib/format.ts) | `lamportsToSol`, `formatSol`, `shortPubkey`, `formatTokenAmount`, `isLikelyPubkey`. |
| API | [`src/app/api/review/route.ts`](src/app/api/review/route.ts) | `POST /api/review` (Node.js runtime). |
| Permalink | [`src/app/tx/[signature]/page.tsx`](src/app/tx/%5Bsignature%5D/page.tsx), [`opengraph-image.tsx`](src/app/tx/%5Bsignature%5D/opengraph-image.tsx) | Server-rendered `/tx/<sig>` review + dynamic OG card. |
| UI | [`src/app/page.tsx`](src/app/page.tsx), [`src/components/ResultView.tsx`](src/components/ResultView.tsx), [`src/components/RiskBadge.tsx`](src/components/RiskBadge.tsx) | Client form + presentational rendering of the result. |

---

## Tech stack

I brought every part of the toolchain current as part of this project (updated by the agent workflow).

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **24.16.0 LTS** | Runtime; the API route and permalink run on the Node.js runtime. |
| npm | **11.16.0** | Package manager. |
| Next.js | **16.2.7** | App Router; `next/og` `ImageResponse` for the OG card. |
| React | **19.2.7** | + `react-dom` 19.2.7. |
| TypeScript | **6.0.3** | Strict shared types across server and UI. |
| Tailwind CSS | **4.3.0** | CSS-first config. `@import "tailwindcss"` in `globals.css` plus `@tailwindcss/postcss`. **No `tailwind.config.js`.** |
| @solana/web3.js | **1.98.4** | The v1 line. (v2 lives on as `@solana/kit` 6.x, noted under [Roadmap](#roadmap) as a future option.) |
| tsx | **4.x** (dev) | Runs the TypeScript regression tests for `npm test`. |

The broader Solana development environment on the build machine is also current. **Rust 1.96.0, Agave / Solana CLI 4.0.1, Anchor 1.0.2.** None of these are used by this read-only web app. I list them only to document that the environment was brought up to date.

---

## Getting started

### Prerequisites

- **Node.js 24 LTS.** Installing via [nvm](https://github.com/nvm-sh/nvm) is recommended:

  ```bash
  nvm install 24
  nvm use 24
  node -v   # v24.16.0
  ```

### Install and run

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file (all values are optional for the PoC)
cp .env.example .env.local

# 3. Start the dev server
npm run dev

# 4. (Optional) run the deterministic risk regression suite
npm test
```

Then open **http://localhost:3000**.

Other scripts: `npm run build`, `npm run start`, `npm run lint`, `npm run typecheck`, and `npm test` (runs [`tests/heuristics.test.ts`](tests/heuristics.test.ts) via `tsx`, 10 checks, all passing).

### Permalink

Any review has a shareable, server-rendered URL: **`/tx/<signature>?cluster=mainnet-beta`** (the `cluster` query is optional and defaults to `mainnet-beta`; `devnet` / `testnet` are also accepted). It reuses the exact same `reviewTransaction` pipeline and `ResultView`, with no new risk logic, and a dynamic Open Graph card makes a pasted link unfurl into a risk preview (level + score + short signature). After any review, the home page also shows an **"Open shareable permalink"** link. Set `NEXT_PUBLIC_SITE_URL` so the OG card resolves to an absolute URL in production (it falls back to `http://localhost:3000` for local dev via `metadataBase` in [`src/app/layout.tsx`](src/app/layout.tsx)).

### A note on the public RPC

The default mainnet endpoint (`https://api.mainnet-beta.solana.com`) **rate-limits heavily and prunes old transactions**, so older signatures will frequently come back as "not found." For reliable results, point the app at a dedicated RPC in one of two ways:

1. **Server-wide.** Set `SOLANA_RPC_URL` in `.env.local` to a Helius / QuickNode / Triton mainnet URL. (This env var applies to `mainnet-beta` only; devnet and testnet always use their public defaults.)
2. **Per-request.** Use the **+ custom RPC** field in the UI to supply an endpoint for a single review.

RPC precedence is: explicit per-request `rpcUrl` → `SOLANA_RPC_URL` (mainnet only) → the public cluster default (`resolveRpcUrl` in [`src/lib/solana.ts`](src/lib/solana.ts)).

---

## Usage

1. **Paste a transaction signature** (a base58 string, ~86–88 characters) into the input.
2. **Pick a cluster**: `mainnet-beta`, `devnet`, or `testnet`.
3. *(Optional)* click **+ custom RPC** and paste your own endpoint to avoid public-RPC rate limits.
4. Click **Review** and read the result:
   - **Overview**: success/failure, slot, block time, fee, compute units, fee payer, signer and writable counts.
   - **AI Explanation**: a plain-English narrative plus key-action bullets and caveats. The provider badge shows `placeholder` by default, or `anthropic` / `openai` once a key is configured (see [The AI layer](#the-ai-layer)).
   - **Risk Report**: overall level + score out of 100, a summary line, and each finding with its detail and evidence.
   - **Programs**, **Token Balance Changes**, **Instructions** (CPIs indented), **Accounts** (with SOL deltas and roles), and collapsible raw **Program Logs**.
5. *(Optional)* click **Open shareable permalink** to get a `/tx/<sig>` URL you can paste anywhere. It unfurls into a risk-preview card.

**Where to get a signature:** copy one from a block explorer such as [Solscan](https://solscan.io) or [Solana Explorer](https://explorer.solana.com), or from your wallet's transaction history.

---

## Project structure

```
solana-agentic-tx-reviewer/
├─ src/
│  ├─ app/
│  │  ├─ api/
│  │  │  └─ review/
│  │  │     └─ route.ts        # POST /api/review (Node.js runtime)
│  │  ├─ tx/
│  │  │  └─ [signature]/
│  │  │     ├─ page.tsx        # GET /tx/<sig> server-rendered review (permalink)
│  │  │     └─ opengraph-image.tsx  # dynamic OG card (risk level + score)
│  │  ├─ globals.css           # Tailwind v4 entry (@import "tailwindcss")
│  │  ├─ layout.tsx            # metadataBase from NEXT_PUBLIC_SITE_URL
│  │  └─ page.tsx              # Client UI: signature input, cluster, custom RPC, permalink link
│  ├─ components/
│  │  ├─ ResultView.tsx        # Renders overview, explanation, risk, accounts…
│  │  └─ RiskBadge.tsx         # Level → colored badge
│  └─ lib/
│     ├─ types.ts              # Shared data model (the contract)
│     ├─ programs.ts           # Known program registry + DEX set + isDexProgram + WSOL_MINT
│     ├─ watchlist.ts          # Curated flagged-address/program list + lookupWatch
│     ├─ format.ts             # lamportsToSol, formatSol, shortPubkey, …
│     ├─ solana.ts             # RPC access (read-only) + assertSafeRpcUrl SSRF guard
│     ├─ parse.ts              # parseTransaction → ParsedTransaction
│     ├─ heuristics.ts         # assessRisk → RiskReport (18 rules)
│     ├─ ai.ts                 # explainTransaction + buildPrompt (real LLM or placeholder)
│     └─ review.ts             # reviewTransaction orchestrator + ReviewError
├─ tests/
│  └─ heuristics.test.ts       # npm test, 10 deterministic regression checks (tsx)
├─ .env.example
├─ next.config.mjs
├─ postcss.config.mjs          # @tailwindcss/postcss
├─ tsconfig.json
└─ package.json
```

---

## Risk heuristics

`assessRisk(tx)` runs a fixed set of **18** pure rules over the parsed transaction. Each rule emits zero or more **findings**. The report dedups same-id findings (merging evidence, tagging `×N`) and aggregates them.

**Scoring & level**

- `LEVEL_WEIGHT`: `info = 0`, `low = 10`, `medium = 25`, `high = 45` (unchanged).
- **Score** = a weighted sum with **diminishing returns** (the *k*-th finding at a given level contributes `weight × 0.5^k`), then clamped to `0–100`. This de-saturates busy-but-benign transactions (a routine swap reads LOW) while keeping real, stacked high-severity signals near the top.
- **Overall level** = the **maximum** individual finding level (not the sum).

**Thresholds** (`THRESHOLDS`)

| Name | Value |
| --- | --- |
| `largeSolOutflow` | 1 SOL |
| `veryLargeSolOutflow` | 10 SOL |
| `manyWritableAccounts` | 12 |
| `highFeeSol` | 0.01 SOL |
| `largeTokenOutflowPct` | 0.5 (50% of pre-balance) |

**Rules**

| ID | Level | Trigger |
| --- | --- | --- |
| `TX_FAILED` | info | `meta.err != null` (transaction failed on-chain) |
| `FLAGGED_ADDRESS` | medium (burn) / high (other) | An account or program matches the curated watchlist ([`src/lib/watchlist.ts`](src/lib/watchlist.ts)) |
| `UNKNOWN_PROGRAM` | medium | Invokes a program not in the registry |
| `LARGE_SOL_OUTFLOW` | medium (≥ 1 SOL) / high (≥ 10 SOL) | Fee payer's net SOL decrease |
| `TOKEN_SWAP` | low | A would-be full-drain / large-outflow where the **same signer** received value back (token inflow > 1 base unit, or net SOL) **and** a known DEX program is present |
| `FULL_TOKEN_ACCOUNT_DRAIN` | high | A **signer-owned** token account goes from pre > 0 to post == 0 (pool/vault PDAs and WSOL excluded) |
| `LARGE_TOKEN_OUTFLOW` | low (≥ 50% of balance) / medium (≥ 90%) | Partial decrease of a **signer-owned** token account |
| `SET_AUTHORITY` | high | spl-token `setAuthority` |
| `ACCOUNT_REASSIGN` | medium | system `assign` |
| `TOKEN_DELEGATE_APPROVE` | medium | spl-token `approve` / `approveChecked` |
| `CLOSE_TOKEN_ACCOUNT` | medium | spl-token `closeAccount` |
| `PROGRAM_DEPLOY_OR_UPGRADE` | medium | BPF Upgradeable Loader involved |
| `MANY_WRITABLE_ACCOUNTS` | low | Writable account count ≥ 12 |
| `HIGH_FEE` | low | Fee > 0.01 SOL |
| `NEW_ACCOUNT_CREATION` | info | system `createAccount` / `createAccountWithSeed` / `allocate` |
| `MULTIPLE_SIGNERS` | info | More than one signer |
| `COMPUTE_BUDGET_SET` | info | Compute Budget program used |
| `MEMO_PRESENT` | info | Memo program used |

**Swap-aware, signer-scoped tuning.** Drain/outflow rules fire **only on signer-owned token accounts**. Pool/vault accounts owned by program PDAs routinely zero out during swaps and are ignored (this killed the biggest false positive, where a routine Jupiter swap previously read HIGH "fully drained" off a pool account). Wrapped SOL (`So111…112`) is excluded from token rules because it is transient and the native SOL rules already cover it. When a known DEX is present and the same signer received non-dust value back, the engine *relabels* the finding as `TOKEN_SWAP` (low) rather than clearing it. An undefined owner or a dusted inflow fails safe to the higher-risk drain finding. Confirmed program IDs registered in [`src/lib/programs.ts`](src/lib/programs.ts) include PumpSwap AMM, pump.fun (bonding curve + Fee), Raydium AMM v4 / CLMM / CPMM, Orca Whirlpools, Meteora DLMM / DAMM v2, Phoenix, Lifinity v2, Jupiter v4 / v6, and Jito Tip. The swap-recognition subset is exposed as `DEX_PROGRAM_IDS` / `isDexProgram()`.

These are **explainable signals, not a verdict.** They surface the patterns a careful reviewer would look for. They do not prove intent, and an `info`/`low` result does not mean a transaction is safe.

---

## The AI layer

`explainTransaction(tx, risk)` produces the natural-language explanation (`summary`, `bullets`, `caveats`, plus `provider` / `model` / `generatedAt`). It runs in one of two modes:

- **Free deterministic placeholder (default).** With no provider or key configured, it composes a plain-English summary, key-action bullets (top SOL moves and token changes), and standing caveats directly from the parsed data and the risk report. So the PoC always works, with **zero keys and zero cost**, returning `provider: "placeholder"`.
- **Real LLM (when configured).** Set `AI_PROVIDER=anthropic|openai` plus the matching API key and `explainTransaction()` genuinely calls the provider behind the existing seam. It builds the grounded context with `buildPrompt(tx, risk)`, asks for strict JSON, parses it, and returns a real `AiExplanation`. The Anthropic path uses **prompt caching** on the static system prompt (5-minute TTL). This is what substantiates the "agentic" claim. On **any** error (missing key, network, rate limit, bad JSON) it degrades gracefully back to the placeholder, so the app never breaks.

```
options.provider  →  process.env.AI_PROVIDER  →  "placeholder"
```

### Connecting a real LLM

1. Pick a provider and add its key to `.env.local` (see `.env.example`):

   ```bash
   AI_PROVIDER=anthropic        # or "openai"
   ANTHROPIC_API_KEY=sk-ant-...
   # ANTHROPIC_MODEL=claude-haiku-4-5-20251001   # optional override
   # OPENAI_API_KEY=sk-...
   # OPENAI_MODEL=gpt-4o-mini                     # optional override
   ```

2. Restart the dev server. That's it. There is **no code change to make**: the provider call (`callAnthropic` / `callOpenAI` in [`src/lib/ai.ts`](src/lib/ai.ts)) is already wired, and every downstream consumer already speaks the `AiExplanation` shape.

The prompt is grounded entirely in deterministically parsed on-chain facts, so the LLM is used to *narrate and prioritize*, not to source data. That keeps explanations faithful to what actually happened.

---

## Roadmap

- **Pre-sign simulation (headline next milestone).** Let an agent or user review an **unsigned** transaction *before* approving it. The recipe is de-risked: accept a base64 unsigned `VersionedTransaction`, call `simulateTransaction({ sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: "base64", addresses } })`, derive account deltas via `getMultipleAccountsInfo`, then reuse the same **parse → risk → explain** pipeline. This closes the agent loop: *propose → review → approve* on a transaction that does not yet exist on-chain.
- Expand the known-program registry and watchlist (from citable public sources only) and add per-program instruction decoding.
- Evaluate migrating from `@solana/web3.js` 1.x to **`@solana/kit` 6.x** (the v2 line).
- Optional persistence for permalinks (today `/tx/<sig>` re-derives the review on each request).
- Tighten the per-request `rpcUrl` guard to a positive host allowlist for production (a baseline SSRF guard already ships, see Disclaimers).

> The real-LLM hook is **done**, not a roadmap item. See [The AI layer](#the-ai-layer).

---

## Disclaimers

- **Not financial, investment, or security advice.** This tool helps you *read* a transaction. It does not certify that one is safe. Heuristics are best-effort **signals**, not guarantees. Always verify on a trusted block explorer before acting.
- **Watchlist is best-effort and non-exhaustive.** The flagged-address list ([`src/lib/watchlist.ts`](src/lib/watchlist.ts)) is curated by hand from public sources and is seeded conservatively (the SOL burn address; no flagged programs by default). A *miss* does not mean an address is safe, and entries should only be added with a citable source.
- **Proof of concept.** No persistence and a small curated program registry. A real LLM is wired in but **off by default** (the explanation is a free deterministic placeholder until you set `AI_PROVIDER` + a key).
- **Read-only by design.** The app only fetches and analyzes existing transactions. It holds no keys and never signs or sends anything.
- **RPC passthrough.** The server can fetch a client-supplied `rpcUrl`, guarded by `assertSafeRpcUrl()` which requires `http(s)` and blocks loopback / private / link-local (cloud-metadata) hosts. A positive host allowlist is still recommended before any public deployment.
- **Public RPC limits.** The default mainnet endpoint rate-limits and prunes history; use a dedicated RPC for dependable results.

---

## License & contact

Built for the **Superteam Agentic Engineering micro-grant** (~200 USDG, Solana Earn).

<!-- CONTACT / LINKS PLACEHOLDER. Add repository URL, license, maintainer contact, and grant wallet here. -->
