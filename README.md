# Solana Agentic Transaction Reviewer

A small, AI-assisted, **read-only** tool for understanding Solana transactions. You give it a transaction (a confirmed signature, or an unsigned transaction you have not signed yet). The app fetches or simulates it over Solana RPC, pulls out the metadata, accounts, instructions (including inner/CPI calls), and token balance changes, runs a set of deterministic risk heuristics, and writes a plain-English explanation next to a structured risk report.

I built it for Solana users and developers who want to **sanity-check a transaction before or after signing**. It catches wallet drains, surprise delegate approvals, authority handovers, and calls into programs nobody recognizes, and it helps you debug what a transaction actually did.

> **Read-only. Nothing is ever signed or sent.** This tool only reads a transaction that already exists on-chain, or *simulates* an unsigned one. It holds no keys, never constructs or submits transactions, and never asks for a wallet connection. The only thing it can do is *read*, *simulate*, and *explain*.

> **Built with agents.** I scaffolded, documented, and adversarially reviewed this project with a multi-agent workflow. Agents brought the toolchain current (Node 24, Rust 1.96, Agave 4.0.1, Anchor 1.0.2). A research-agent discovery pass confirmed the program IDs. The heuristics were de-risked agent-by-agent against routine swaps and real drains.

This is a deliberately small proof-of-concept built for the **Superteam Agentic Engineering micro-grant** (~200 USDG, Solana Earn). There is no new on-chain protocol, no signing, and no persistence. It is just an explainable analysis pipeline that a real agent could plug into.

### Why this matters for Solana's agentic future

Think of the reviewer as the review step an agent runs before it signs. An agent proposes a transaction, the reviewer judges it (**parse, heuristics, explanation**), and a human or agent approves. As autonomous agents start moving value on Solana, a deterministic, auditable "second opinion" between *proposed* and *signed* is exactly the missing piece. That is the headline reason I built this PoC the way I did. And with the pre-sign mode below, that "second opinion" now runs on a transaction that does not yet exist on-chain.

---

## Features

- **Two input modes: confirmed signature or unsigned (pre-sign) transaction.** The home page has a toggle. Review a confirmed transaction by signature (post-hoc), or paste a base64-serialized **unsigned** transaction and see what it *would* do before you sign it. Both modes produce the same review.
- **Pre-sign simulation** ([`src/lib/presign.ts`](src/lib/presign.ts)). The headline feature, built and verified live. It accepts a base64 `VersionedTransaction`, deserializes it, resolves any v0 address lookup tables, and simulates it read-only with `connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: "base64", addresses: writableAccounts } })`. It then derives SOL and SPL token deltas by diffing the pre-state (`getMultipleAccountsInfo`) against the simulated post-state (token amount = u64 LE at byte 64, mint decimals from byte 44). A small discriminator decoder recovers SPL Token and System instruction *types* from the raw instruction data, so the same `parsedType`-dependent heuristics still fire (`setAuthority`, `approve`, `closeAccount`, `createAccount`, and the rest). The output is the **same `ParsedTransaction`** the confirmed path produces (with `simulated: true`), so the risk engine, the explanation, and the UI are unchanged. Nothing is ever signed or sent. Simulation only.
- **Token metadata enrichment** ([`src/lib/metadata.ts`](src/lib/metadata.ts)). Resolves a mint to `{ symbol, name, logoURI }` via a small known-token registry (SOL, USDC, USDT, BONK, JUP, WIF, JTO) plus a cached, best-effort Jupiter datapi lookup (`https://datapi.jup.ag/v1/assets/search?query=<mint>`), with graceful fallback to the raw mint when a token is unknown or the endpoint is unreachable. Token tables and the explanation show e.g. "USDC" and a logo instead of a raw mint and a base-unit delta. `enrichTokenMetadata()` runs in `reviewTransaction()` for **both** paths and never throws.
- **Signature input.** Paste any base58 transaction signature. Structural validation runs before any network call (`isValidSignature` in [`src/lib/solana.ts`](src/lib/solana.ts)).
- **RPC fetch.** Read-only `getParsedTransaction` with `maxSupportedTransactionVersion: 0`, so both legacy and versioned (v0) transactions resolve.
- **Deterministic parsing** ([`src/lib/parse.ts`](src/lib/parse.ts)) normalizes the raw RPC response into a single UI-ready model:
  - accounts with their **signer / writable / program** roles and per-account **net SOL delta** (post minus pre balances),
  - **top-level and inner (CPI) instructions** flattened into one ordered list, each tagged with its program and parsed instruction type,
  - **SPL token balance changes** computed from `pre`/`postTokenBalances` (before, after, and delta per token account),
  - **aggregated program invocations** with friendly names and call counts.
- **Deterministic risk report** ([`src/lib/heuristics.ts`](src/lib/heuristics.ts)). Pure, explainable rules (now **18** of them) that surface drains, authority changes, delegate approvals, unknown programs, large outflows, and more, each with a level, a human-readable detail, and supporting evidence.
- **Swap-aware, signer-scoped heuristics.** Drain/outflow rules fire **only on signer-owned token accounts** (pool/vault PDAs that routinely zero out during swaps are ignored), wrapped SOL is excluded from token rules, and a `TOKEN_SWAP` rule defensively relabels a would-be drain when the **same signer received value back through a known DEX**. This kills the biggest false positive (a routine Jupiter swap previously read HIGH).
- **Known-address watchlist** ([`src/lib/watchlist.ts`](src/lib/watchlist.ts)). A curated, best-effort, non-exhaustive list that raises a `FLAGGED_ADDRESS` finding (seeded honestly with the SOL burn/incinerator address; flagged program IDs are empty by default to avoid false accusations).
- **De-saturated scoring.** `assessRisk` dedups same-id findings and applies **diminishing returns** per level so a routine swap reads LOW while a real, stacked drainer stays HIGH.
- **Real dual-provider LLM behind the seam** ([`src/lib/ai.ts`](src/lib/ai.ts)). The explanation layer genuinely calls **Anthropic or OpenAI** when a key is configured (Anthropic uses prompt caching on the system prompt), with a **free deterministic placeholder default** and graceful fallback on *any* error (missing key, network, rate limit, bad JSON).
- **Shareable permalink** ([`src/app/tx/[signature]/page.tsx`](src/app/tx/%5Bsignature%5D/page.tsx)). `GET /tx/<signature>?cluster=...` server-renders the full review pipeline, and a Next 16 [`ImageResponse`](src/app/tx/%5Bsignature%5D/opengraph-image.tsx) OG card (risk level + score + short signature) makes a pasted link unfurl into a risk preview. The permalink is for confirmed reviews. A simulated, unsigned transaction has no signature, so no permalink is shown for the pre-sign path.
- **`npm test` regression suite** ([`tests/heuristics.test.ts`](tests/heuristics.test.ts)). 24 deterministic checks proving swaps stay LOW, real drains stay HIGH, pool/WSOL noise is filtered, and the watchlist fires.
- **Cluster + custom RPC support.** Switch between `mainnet-beta`, `devnet`, and `testnet`, and optionally supply your own Helius / QuickNode / Triton endpoint to avoid public-RPC rate limits.

---

## Architecture

The pipeline is a single linear flow with two front doors. The client posts either a `signature` (confirmed path) or a `rawTransaction` (pre-sign path) to one API route, or hits the `/tx/<sig>` permalink. Either input produces a `ParsedTransaction`, and from there the stages are identical: enrich token metadata, assess risk, explain.

```
                         ┌─────────────────────────────────────────────────────┐
   Browser UI            │                  Next.js (Node runtime)              │
 ┌───────────────┐       │                                                      │
 │  page.tsx     │  POST │  app/api/review/route.ts   (and /tx/[sig] permalink) │
 │  signature ───┼──────►│        │                                             │
 │  OR raw tx    │ /api/ │        ▼                                             │
 │  cluster      │review │  lib/review.ts  reviewTransaction(request)           │
 │  custom RPC   │       │        │                                             │
 └───────▲───────┘       │        ├── signature ─► lib/solana.ts fetch          │
         │               │        │      then lib/parse.ts → ParsedTransaction  │
         │               │        │                                             │
         │               │        └── rawTransaction ─► lib/presign.ts          │
         │               │               simulate (read-only) → ParsedTransaction
         │  ReviewResult │        │                                             │
         │   (JSON)      │        ▼                                             │
         │               │   ① enrich ─► lib/metadata.ts  token symbol/logo     │
         │               │        ▼                                             │
         │               │   ② risk  ──► lib/heuristics.ts  RiskReport          │
         │               │        │      (18 rules → deduped, de-saturated)     │
         │               │        ▼                                             │
         │               │   ③ explain ► lib/ai.ts        AiExplanation         │
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
| Contract | [`src/lib/types.ts`](src/lib/types.ts) | Shared data model every stage speaks: `ReviewRequest` (`signature` \| `rawTransaction`), `ParsedTransaction` (with `simulated`), `RiskReport`, `AiExplanation`, `ReviewResult`, and supporting types. |
| Fetch (confirmed) | [`src/lib/solana.ts`](src/lib/solana.ts) | `getConnection`, `resolveRpcUrl`, `assertSafeRpcUrl`, `isValidSignature`, `fetchParsedTransaction`. |
| Parse (confirmed) | [`src/lib/parse.ts`](src/lib/parse.ts) | `parseTransaction(raw, signature, cluster)` → `ParsedTransaction`. |
| Simulate (pre-sign) | [`src/lib/presign.ts`](src/lib/presign.ts) | `simulateAndReview(rawBase64, cluster, rpcUrl)` → `ParsedTransaction` (`simulated: true`); `PresignError`. |
| Enrich | [`src/lib/metadata.ts`](src/lib/metadata.ts) | `enrichTokenMetadata(changes)` resolves mint → `{ symbol, name, logoURI }` (known registry + cached Jupiter lookup). Never throws. |
| Risk | [`src/lib/heuristics.ts`](src/lib/heuristics.ts) | `assessRisk(tx)` → `RiskReport` (dedupe + diminishing-returns scoring). |
| Explain | [`src/lib/ai.ts`](src/lib/ai.ts) | `explainTransaction(tx, risk)` + `buildPrompt(tx, risk)` (real LLM or placeholder). |
| Orchestrator | [`src/lib/review.ts`](src/lib/review.ts) | `reviewTransaction(request)` picks the confirmed or pre-sign path, then chains enrich, risk, explain. Throws `ReviewError(status)`. |
| Support | [`src/lib/programs.ts`](src/lib/programs.ts) | Registry of known program IDs → `{ name, category }`; `resolveProgram`, `isKnownProgram`, `isDexProgram`, `DEX_PROGRAM_IDS`, `WSOL_MINT`. |
| Support | [`src/lib/watchlist.ts`](src/lib/watchlist.ts) | Curated flagged-address/program list; `lookupWatch(address)`. |
| Support | [`src/lib/format.ts`](src/lib/format.ts) | `lamportsToSol`, `formatSol`, `shortPubkey`, `formatTokenAmount`, `isLikelyPubkey`. |
| API | [`src/app/api/review/route.ts`](src/app/api/review/route.ts) | `POST /api/review` (Node.js runtime). |
| Permalink | [`src/app/tx/[signature]/page.tsx`](src/app/tx/%5Bsignature%5D/page.tsx), [`opengraph-image.tsx`](src/app/tx/%5Bsignature%5D/opengraph-image.tsx) | Server-rendered `/tx/<sig>` review + dynamic OG card (confirmed only). |
| UI | [`src/app/page.tsx`](src/app/page.tsx), [`src/components/ResultView.tsx`](src/components/ResultView.tsx), [`src/components/RiskBadge.tsx`](src/components/RiskBadge.tsx) | Client form (signature / unsigned toggle) + presentational rendering, including the "SIMULATED" badge, "Would succeed / Would fail", and token symbols. |

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

Other scripts: `npm run build`, `npm run start`, `npm run lint`, `npm run typecheck`, and `npm test` (runs [`tests/heuristics.test.ts`](tests/heuristics.test.ts) via `tsx`, 24 checks, all passing). The pre-sign and token-metadata features need a live RPC (and a network call for unknown tokens), so they were verified by live integration against mainnet rather than in the offline unit suite.

### Permalink

Any **confirmed** review has a shareable, server-rendered URL: **`/tx/<signature>?cluster=mainnet-beta`** (the `cluster` query is optional and defaults to `mainnet-beta`; `devnet` / `testnet` are also accepted). It reuses the exact same `reviewTransaction` pipeline and `ResultView`, with no new risk logic, and a dynamic Open Graph card makes a pasted link unfurl into a risk preview (level + score + short signature). After any confirmed review, the home page also shows an **"Open shareable permalink"** link. A simulated, unsigned transaction has no signature, so no permalink is shown for the pre-sign path. Set `NEXT_PUBLIC_SITE_URL` so the OG card resolves to an absolute URL in production (it falls back to `http://localhost:3000` for local dev via `metadataBase` in [`src/app/layout.tsx`](src/app/layout.tsx)).

### A note on the public RPC

The default mainnet endpoint (`https://api.mainnet-beta.solana.com`) **rate-limits heavily and prunes old transactions**, so older signatures will frequently come back as "not found." The pre-sign path is even more sensitive here, because public RPC rate-limits simulate-with-accounts, so the pre-sign mode effectively needs a custom RPC. For reliable results, point the app at a dedicated RPC in one of two ways:

1. **Server-wide.** Set `SOLANA_RPC_URL` in `.env.local` to a Helius / QuickNode / Triton mainnet URL. (This env var applies to `mainnet-beta` only; devnet and testnet always use their public defaults.)
2. **Per-request.** Use the **+ custom RPC** field in the UI to supply an endpoint for a single review.

RPC precedence is: explicit per-request `rpcUrl`, then `SOLANA_RPC_URL` (mainnet only), then the public cluster default (`resolveRpcUrl` in [`src/lib/solana.ts`](src/lib/solana.ts)).

---

## Usage

### Confirmed signature (post-hoc review)

1. Keep the **Confirmed signature** tab selected.
2. **Paste a transaction signature** (a base58 string, ~86 to 88 characters) into the input.
3. **Pick a cluster**: `mainnet-beta`, `devnet`, or `testnet`.
4. *(Optional)* click **+ custom RPC** and paste your own endpoint to avoid public-RPC rate limits.
5. Click **Review** and read the result.

### Unsigned transaction (pre-sign review)

1. Switch to the **Unsigned tx (pre-sign)** tab.
2. **Paste a base64-serialized unsigned transaction** into the textarea. The app deserializes it, simulates it read-only, and shows what it *would* do if signed and sent now. A custom RPC is recommended here, because public RPC rate-limits simulate-with-accounts.
3. **Pick a cluster** and click **Review**. The result carries a **SIMULATED** badge, the overview reads **"Would succeed" / "Would fail"** instead of success/failure, and the explanation is framed as "This is a read-only simulation of an unsigned transaction. If signed and sent now, it would..." Honest note: the fee is not computed during simulation (shown as not-applicable), and because the blockhash is replaced, the real result after signing can differ if on-chain state changes before you submit.

### What you get either way

- **Overview**: status, slot, block time, fee, compute units, fee payer, signer and writable counts. For the pre-sign path the signature, slot, block time, and fee are shown as not-applicable, and the status reads "Would succeed / Would fail."
- **AI Explanation**: a plain-English narrative plus key-action bullets and caveats. The provider badge shows `placeholder` by default, or `anthropic` / `openai` once a key is configured (see [The AI layer](#the-ai-layer)).
- **Risk Report**: overall level + score out of 100, a summary line, and each finding with its detail and evidence.
- **Programs**, **Token Balance Changes** (with token symbols and logos where known), **Instructions** (CPIs indented), **Accounts** (with SOL deltas and roles), and collapsible raw **Program Logs**.
- *(Confirmed only, optional)* click **Open shareable permalink** to get a `/tx/<sig>` URL you can paste anywhere. It unfurls into a risk-preview card.

**Where to get a confirmed signature:** copy one from a block explorer such as [Solscan](https://solscan.io) or [Solana Explorer](https://explorer.solana.com), or from your wallet's transaction history. **Where to get an unsigned transaction:** serialize a `VersionedTransaction` to base64 (for example from your dApp or agent right before it would prompt for a signature).

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
│  │  └─ page.tsx              # Client UI: signature / unsigned toggle, cluster, custom RPC, permalink link
│  ├─ components/
│  │  ├─ ResultView.tsx        # Renders overview, explanation, risk, accounts, SIMULATED badge, token symbols
│  │  └─ RiskBadge.tsx         # Level → colored badge
│  └─ lib/
│     ├─ types.ts              # Shared data model (the contract)
│     ├─ programs.ts           # Known program registry + DEX set + isDexProgram + WSOL_MINT
│     ├─ watchlist.ts          # Curated flagged-address/program list + lookupWatch
│     ├─ format.ts             # lamportsToSol, formatSol, shortPubkey, …
│     ├─ solana.ts             # RPC access (read-only) + assertSafeRpcUrl SSRF guard
│     ├─ parse.ts              # parseTransaction → ParsedTransaction (confirmed path)
│     ├─ presign.ts            # simulateAndReview → ParsedTransaction (pre-sign path)
│     ├─ metadata.ts           # enrichTokenMetadata → mint symbol/name/logo
│     ├─ heuristics.ts         # assessRisk → RiskReport (18 rules)
│     ├─ ai.ts                 # explainTransaction + buildPrompt (real LLM or placeholder)
│     └─ review.ts             # reviewTransaction orchestrator + ReviewError
├─ tests/
│  └─ heuristics.test.ts       # npm test, 24 deterministic regression checks (tsx)
├─ .env.example
├─ next.config.mjs
├─ postcss.config.mjs          # @tailwindcss/postcss
├─ tsconfig.json
└─ package.json
```

---

## Risk heuristics

`assessRisk(tx)` runs a fixed set of **18** pure rules over the parsed transaction. They run identically on a confirmed transaction and on a simulated unsigned one, because both arrive as the same `ParsedTransaction`. Each rule emits zero or more **findings**. The report dedups same-id findings (merging evidence, tagging `×N`) and aggregates them.

**Scoring & level**

- `LEVEL_WEIGHT`: `info = 0`, `low = 10`, `medium = 25`, `high = 45` (unchanged).
- **Score** = a weighted sum with **diminishing returns** (the *k*-th finding at a given level contributes `weight × 0.5^k`), then clamped to `0` to `100`. This de-saturates busy-but-benign transactions (a routine swap reads LOW) while keeping real, stacked high-severity signals near the top.
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

- **Free deterministic placeholder (default).** With no provider or key configured, it composes a plain-English summary, key-action bullets (top SOL moves and token changes), and standing caveats directly from the parsed data and the risk report. So the PoC always works, with **zero keys and zero cost**, returning `provider: "placeholder"`. For a simulated transaction the summary is framed as "This is a read-only simulation of an unsigned transaction. If signed and sent now, it would...", and it adds the caveat that a replaced blockhash means the real result can differ.
- **Real LLM (when configured).** Set `AI_PROVIDER=anthropic|openai` plus the matching API key and `explainTransaction()` genuinely calls the provider behind the existing seam. It builds the grounded context with `buildPrompt(tx, risk)` (which tells the model whether this is a confirmed transaction or a pre-sign simulation), asks for strict JSON, parses it, and returns a real `AiExplanation`. The Anthropic path uses **prompt caching** on the static system prompt (5-minute TTL). This is what substantiates the "agentic" claim. On **any** error (missing key, network, rate limit, bad JSON) it degrades gracefully back to the placeholder, so the app never breaks.

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

Two of the bigger items are now shipped, not planned: **pre-sign simulation** ([`src/lib/presign.ts`](src/lib/presign.ts)) and **token metadata enrichment** ([`src/lib/metadata.ts`](src/lib/metadata.ts)). They are described above. Estimates below are in days at agent pace.

- **Deepen the LLM guardrails (2 to 4 days).** Tighten the prompt and add output validation so the narration can never contradict the deterministic facts, with regression fixtures for the explanation layer.
- **Richer program / IDL labeling and a CPI tree view (3 to 5 days).** Decode more programs' instruction types (today the pre-sign decoder covers SPL Token + System; other programs' instruction *types* are not decoded, though the balance, program, and watchlist heuristics still apply), and render the inner-instruction tree as an actual tree in the UI.
- **Expand heuristics, grow the watchlist, and harden (2 to 4 days).** Add rules, expand the known-program registry and watchlist from citable public sources only, and tighten the per-request `rpcUrl` guard to a positive host allowlist for production (a baseline SSRF guard already ships; see Disclaimers).
- **Evaluate migrating from `@solana/web3.js` 1.x to `@solana/kit` 6.x (the v2 line).**
- **Optional persistence for permalinks** (today `/tx/<sig>` re-derives the review on each request).

> The real-LLM hook is **done**, not a roadmap item. See [The AI layer](#the-ai-layer).

---

## Disclaimers

- **Not financial, investment, or security advice.** This tool helps you *read* a transaction. It does not certify that one is safe. Heuristics are best-effort **signals**, not guarantees. Always verify on a trusted block explorer before acting.
- **Simulation is not the final word.** The pre-sign path replaces the blockhash and runs without signature verification, so it reports what a transaction *would* do against current on-chain state. The real result after signing can differ if state changes before you submit, and the fee is not computed during simulation.
- **Watchlist is best-effort and non-exhaustive.** The flagged-address list ([`src/lib/watchlist.ts`](src/lib/watchlist.ts)) is curated by hand from public sources and is seeded conservatively (the SOL burn address; no flagged programs by default). A *miss* does not mean an address is safe, and entries should only be added with a citable source.
- **Proof of concept.** No persistence and a small curated program registry. A real LLM is wired in but **off by default** (the explanation is a free deterministic placeholder until you set `AI_PROVIDER` + a key).
- **Read-only by design.** The app only fetches, simulates, and analyzes transactions. It holds no keys and never signs or sends anything.
- **RPC passthrough.** The server can fetch a client-supplied `rpcUrl`, guarded by `assertSafeRpcUrl()` which requires `http(s)` and blocks loopback / private / link-local (cloud-metadata) hosts. A positive host allowlist is still recommended before any public deployment.
- **Public RPC limits.** The default mainnet endpoint rate-limits and prunes history, and it rate-limits simulate-with-accounts in particular, so use a dedicated RPC for dependable results (and effectively a requirement for the pre-sign path).

---

## License & contact

Built for the **Superteam Agentic Engineering micro-grant** (~200 USDG, Solana Earn). Repo is public at https://github.com/plutohan/solana-agentic-tx-reviewer.

<!-- CONTACT / LINKS PLACEHOLDER. Add repository URL, license, maintainer contact, and grant wallet here. -->
