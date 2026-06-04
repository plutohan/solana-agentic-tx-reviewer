# Solana Agentic Transaction Reviewer

A lightweight, AI-assisted, **read-only** tool for understanding Solana transactions. Paste a transaction signature and the app fetches it over Solana RPC, extracts the metadata, accounts, instructions (including inner/CPI calls), and token balance changes, runs a set of deterministic risk heuristics, and produces a plain-English explanation alongside a structured risk report.

It is built for Solana users and developers who want to **sanity-check a transaction before or after signing** — to catch wallet drains, surprise delegate approvals, authority handovers, and interactions with unrecognized programs, and to debug what a transaction actually did.

> **Read-only — nothing is ever signed or sent.** This tool only calls `getParsedTransaction` against an RPC endpoint. It holds no keys, never constructs or submits transactions, and never asks for a wallet connection. The only thing it can do is *read* and *explain* a transaction that already exists on-chain.

This is a deliberately small proof-of-concept built for the **Superteam Agentic Engineering Grant**. There is no new on-chain protocol, no signing, and no persistence — just an explainable analysis pipeline that a real agent could plug into.

---

## Features

- **Signature input** — paste any base58 transaction signature; structural validation runs before any network call (`isValidSignature` in [`src/lib/solana.ts`](src/lib/solana.ts)).
- **RPC fetch** — read-only `getParsedTransaction` with `maxSupportedTransactionVersion: 0`, so both legacy and versioned (v0) transactions resolve.
- **Deterministic parsing** ([`src/lib/parse.ts`](src/lib/parse.ts)) normalizes the raw RPC response into a single UI-ready model:
  - accounts with their **signer / writable / program** roles and per-account **net SOL delta** (post − pre balances),
  - **top-level and inner (CPI) instructions** flattened into one ordered list, each tagged with its program and parsed instruction type,
  - **SPL token balance changes** computed from `pre`/`postTokenBalances` (before, after, and delta per token account),
  - **aggregated program invocations** with friendly names and call counts.
- **Deterministic risk report** ([`src/lib/heuristics.ts`](src/lib/heuristics.ts)) — pure, explainable rules that surface drains, authority changes, delegate approvals, unknown programs, large outflows, and more, each with a level, a human-readable detail, and supporting evidence.
- **Placeholder AI explanation** ([`src/lib/ai.ts`](src/lib/ai.ts)) — a deterministic, template-based natural-language summary so the PoC runs with **zero API keys and zero cost**. The seam for a real LLM (OpenAI / Anthropic) is fully defined and ready to connect.
- **Cluster + custom RPC support** — switch between `mainnet-beta`, `devnet`, and `testnet`, and optionally supply your own Helius / QuickNode / Triton endpoint to avoid public-RPC rate limits.

---

## Architecture

The pipeline is a single linear flow. The client posts a signature to one API route, which runs the four library stages in order and returns a `ReviewResult`.

```
                         ┌─────────────────────────────────────────────────────┐
   Browser UI            │                  Next.js (Node runtime)              │
 ┌───────────────┐       │                                                      │
 │  page.tsx     │  POST │  app/api/review/route.ts                             │
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
         │               │        │      (deterministic rules → score + level)  │
         │               │        ▼                                             │
         │               │   ④ explain ► lib/ai.ts        AiExplanation         │
         │               │        │      (placeholder template; LLM-ready)      │
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
| ① Fetch | [`src/lib/solana.ts`](src/lib/solana.ts) | `getConnection`, `resolveRpcUrl`, `isValidSignature`, `fetchParsedTransaction`. |
| ② Parse | [`src/lib/parse.ts`](src/lib/parse.ts) | `parseTransaction(raw, signature, cluster)` → `ParsedTransaction`. |
| ③ Risk | [`src/lib/heuristics.ts`](src/lib/heuristics.ts) | `assessRisk(tx)` → `RiskReport`. |
| ④ Explain | [`src/lib/ai.ts`](src/lib/ai.ts) | `explainTransaction(tx, risk)` + `buildPrompt(tx, risk)`. |
| Orchestrator | [`src/lib/review.ts`](src/lib/review.ts) | `reviewTransaction(request)` chains all four stages; throws `ReviewError(status)`. |
| Support | [`src/lib/programs.ts`](src/lib/programs.ts) | Registry of known program IDs → `{ name, category }`; `resolveProgram`, `isKnownProgram`. |
| Support | [`src/lib/format.ts`](src/lib/format.ts) | `lamportsToSol`, `formatSol`, `shortPubkey`, `formatTokenAmount`, `isLikelyPubkey`. |
| API | [`src/app/api/review/route.ts`](src/app/api/review/route.ts) | `POST /api/review` (Node.js runtime). |
| UI | [`src/app/page.tsx`](src/app/page.tsx), [`src/components/ResultView.tsx`](src/components/ResultView.tsx), [`src/components/RiskBadge.tsx`](src/components/RiskBadge.tsx) | Client form + presentational rendering of the result. |

---

## Tech stack

Every part of the toolchain was brought current as part of this project.

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **24.16.0 LTS** | Runtime; the API route runs on the Node.js runtime. |
| npm | **11.16.0** | Package manager. |
| Next.js | **16.2.7** | App Router. |
| React | **19.2.7** | + `react-dom` 19.2.7. |
| TypeScript | **6.0.3** | Strict shared types across server and UI. |
| Tailwind CSS | **4.3.0** | CSS-first config — `@import "tailwindcss"` in `globals.css` plus `@tailwindcss/postcss`. **No `tailwind.config.js`.** |
| @solana/web3.js | **1.98.4** | The v1 line. (v2 lives on as `@solana/kit` 6.x — noted under [Roadmap](#roadmap) as a future option.) |

The broader Solana development environment on the build machine is also current — **Rust 1.96.0, Agave / Solana CLI 4.0.1, Anchor 1.0.2** — but none of these are used by this read-only web app. They are listed only to document that the environment was brought up to date.

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
```

Then open **http://localhost:3000**.

Other scripts: `npm run build`, `npm run start`, `npm run lint`, `npm run typecheck`.

### A note on the public RPC

The default mainnet endpoint (`https://api.mainnet-beta.solana.com`) **rate-limits heavily and prunes old transactions**, so older signatures will frequently come back as "not found." For reliable results, point the app at a dedicated RPC in one of two ways:

1. **Server-wide** — set `SOLANA_RPC_URL` in `.env.local` to a Helius / QuickNode / Triton mainnet URL. (This env var applies to `mainnet-beta` only; devnet and testnet always use their public defaults.)
2. **Per-request** — use the **+ custom RPC** field in the UI to supply an endpoint for a single review.

RPC precedence is: explicit per-request `rpcUrl` → `SOLANA_RPC_URL` (mainnet only) → the public cluster default (`resolveRpcUrl` in [`src/lib/solana.ts`](src/lib/solana.ts)).

---

## Usage

1. **Paste a transaction signature** (a base58 string, ~86–88 characters) into the input.
2. **Pick a cluster** — `mainnet-beta`, `devnet`, or `testnet`.
3. *(Optional)* click **+ custom RPC** and paste your own endpoint to avoid public-RPC rate limits.
4. Click **Review** and read the result:
   - **Overview** — success/failure, slot, block time, fee, compute units, fee payer, signer and writable counts.
   - **AI Explanation** — a plain-English narrative plus key-action bullets and caveats (provider badge shows `placeholder` today).
   - **Risk Report** — overall level + score out of 100, a summary line, and each finding with its detail and evidence.
   - **Programs**, **Token Balance Changes**, **Instructions** (CPIs indented), **Accounts** (with SOL deltas and roles), and collapsible raw **Program Logs**.

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
│  │  ├─ globals.css           # Tailwind v4 entry (@import "tailwindcss")
│  │  ├─ layout.tsx
│  │  └─ page.tsx              # Client UI: signature input, cluster, custom RPC
│  ├─ components/
│  │  ├─ ResultView.tsx        # Renders overview, explanation, risk, accounts…
│  │  └─ RiskBadge.tsx         # Level → colored badge
│  └─ lib/
│     ├─ types.ts              # Shared data model (the contract)
│     ├─ programs.ts           # Known program registry + resolveProgram/isKnownProgram
│     ├─ format.ts             # lamportsToSol, formatSol, shortPubkey, …
│     ├─ solana.ts             # RPC access (read-only getParsedTransaction)
│     ├─ parse.ts              # parseTransaction → ParsedTransaction
│     ├─ heuristics.ts         # assessRisk → RiskReport
│     ├─ ai.ts                 # explainTransaction + buildPrompt (LLM-ready)
│     └─ review.ts             # reviewTransaction orchestrator + ReviewError
├─ .env.example
├─ next.config.mjs
├─ postcss.config.mjs          # @tailwindcss/postcss
├─ tsconfig.json
└─ package.json
```

---

## Risk heuristics

`assessRisk(tx)` runs a fixed set of pure rules over the parsed transaction. Each rule emits zero or more **findings**; the report aggregates them.

**Scoring & level**

- `LEVEL_WEIGHT`: `info = 0`, `low = 10`, `medium = 25`, `high = 45`.
- **Score** = the sum of all finding weights, clamped to `0–100`.
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
| `UNKNOWN_PROGRAM` | medium | Invokes a program not in the registry |
| `LARGE_SOL_OUTFLOW` | medium (≥ 1 SOL) / high (≥ 10 SOL) | Fee payer's net SOL decrease |
| `FULL_TOKEN_ACCOUNT_DRAIN` | high | A token account goes from pre > 0 to post == 0 |
| `LARGE_TOKEN_OUTFLOW` | low (≥ 50% of balance) / medium (≥ 90%) | Partial token-account decrease |
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

These are **explainable signals, not a verdict.** They are designed to surface the patterns a careful reviewer would look for — they do not prove intent, and an `info`/`low` result does not mean a transaction is safe.

---

## The AI layer

Today, `explainTransaction(tx, risk)` returns a **deterministic, template-based** explanation with `provider: "placeholder"`. It composes a plain-English summary, key-action bullets (top SOL moves and token changes), and standing caveats directly from the parsed data and the risk report — so the PoC always works, with no keys and no cost.

The seam for a real model is already in place:

- **`buildPrompt(tx, risk)`** — a pure, exported function that returns the exact context string a real LLM would receive (signature, cluster, fee, signers, programs, token balance changes, instruction types, and the deterministic risk findings). It instructs the model to use only the provided facts and never invent addresses, amounts, or intent.
- **The provider switch in `explainTransaction()`** — reads the provider from `options.provider` → `process.env.AI_PROVIDER` → `"placeholder"`. The `openai` / `anthropic` branch marks exactly where the SDK call slots in; until a key is configured it deliberately falls through to the placeholder so the app never breaks.

### Connecting a real LLM

1. Pick a provider and add its key to `.env.local` (see `.env.example`):

   ```bash
   AI_PROVIDER=anthropic        # or "openai"
   ANTHROPIC_API_KEY=sk-ant-...
   # OPENAI_API_KEY=sk-...
   ```

2. In [`src/lib/ai.ts`](src/lib/ai.ts), fill in the `openai` / `anthropic` branch of `explainTransaction()`: call `buildPrompt(tx, risk)`, send it to the provider's SDK, and return an `AiExplanation` (`summary`, `bullets`, `caveats`, `model`, `generatedAt`). No other code changes are required — every downstream consumer already speaks the `AiExplanation` shape.

Because the prompt is grounded entirely in deterministically parsed on-chain facts, the LLM is used to *narrate and prioritize* — not to source data — which keeps explanations faithful to what actually happened.

---

## Roadmap

- Wire a real LLM behind `AI_PROVIDER` (the hook is already in place).
- Expand the known-program registry in [`src/lib/programs.ts`](src/lib/programs.ts) and add per-program instruction decoding.
- Evaluate migrating from `@solana/web3.js` 1.x to **`@solana/kit` 6.x** (the v2 line).
- Optional persistence / shareable review links.
- Tighten the per-request `rpcUrl` guard to a positive host allowlist for production (a baseline SSRF guard already ships — see Disclaimers).

---

## Disclaimers

- **Not financial, investment, or security advice.** This tool helps you *read* a transaction; it does not certify that one is safe. Heuristics are best-effort **signals**, not guarantees — always verify on a trusted block explorer before acting.
- **Proof of concept.** No persistence, no real LLM (the explanation is a deterministic placeholder), and a small curated program registry.
- **Read-only by design.** The app only fetches and analyzes existing transactions. It holds no keys and never signs or sends anything.
- **RPC passthrough.** The server can fetch a client-supplied `rpcUrl`, guarded by `assertSafeRpcUrl()` which requires `http(s)` and blocks loopback / private / link-local (cloud-metadata) hosts. A positive host allowlist is still recommended before any public deployment.
- **Public RPC limits.** The default mainnet endpoint rate-limits and prunes history; use a dedicated RPC for dependable results.

---

## License & contact

Built for the **Superteam Agentic Engineering Grant** (~200 USDG).

<!-- CONTACT / LINKS PLACEHOLDER — add repository URL, license, and maintainer contact here. -->
