# Solana Agentic Transaction Reviewer — Technical Plan

> A lightweight, AI-assisted, **read-only** Solana transaction review tool. Paste a transaction
> signature; the app fetches it over RPC, extracts metadata / accounts / instructions / token
> balance changes, runs deterministic risk heuristics, and produces a human-readable explanation
> plus a risk report.
>
> This is a proof-of-concept built for the **Superteam Agentic Engineering Grant** (~200 USDG).
> Scope is deliberately small: read-only analysis only. There is **no new protocol**, and the app
> **never signs or sends** anything.

---

## Table of contents

1. [System overview & pipeline](#1-system-overview--pipeline)
2. [Tech stack & rationale](#2-tech-stack--rationale)
3. [Data model — the shared contract](#3-data-model--the-shared-contract)
4. [Module responsibilities](#4-module-responsibilities)
5. [RPC strategy](#5-rpc-strategy)
6. [The AI seam](#6-the-ai-seam)
7. [Security & limitations](#7-security--limitations)
8. [Testing & extension](#8-testing--extension)

---

## 1. System overview & pipeline

The reviewer is a single Next.js application with a thin client UI and one server endpoint. All
on-chain work happens server-side (the `@solana/web3.js` client needs Node APIs and we never expose
RPC credentials to the browser). The entire flow is a straight, deterministic pipeline:

```
                         ┌──────────────────────────────────────────────────────────────────┐
  Browser                │                         Node.js server                            │
 (page.tsx)              │                                                                    │
                         │                                                                    │
  signature ───POST────► │  src/app/api/review/route.ts                                       │
  cluster                │      │  validates JSON body                                        │
  rpcUrl?                │      ▼                                                              │
                         │  src/lib/review.ts  reviewTransaction(request)                     │
                         │      │                                                              │
                         │      │ 1. isValidSignature()      (src/lib/solana.ts)               │
                         │      ▼                                                              │
                         │  ┌─────────── FETCH ───────────┐                                    │
                         │  │ fetchParsedTransaction()    │ ── Solana RPC (getParsedTransaction)│
                         │  │  src/lib/solana.ts          │ ◄─ ParsedTransactionWithMeta | null │
                         │  └─────────────┬───────────────┘                                    │
                         │                ▼                                                     │
                         │  ┌─────────── PARSE ───────────┐                                    │
                         │  │ parseTransaction()          │  normalize → ParsedTransaction      │
                         │  │  src/lib/parse.ts           │  (SOL deltas, token deltas,         │
                         │  └─────────────┬───────────────┘   flattened top-level + CPI ixs)    │
                         │                ▼                                                     │
                         │  ┌────────── HEURISTICS ───────┐                                    │
                         │  │ assessRisk()                │  deterministic rules → RiskReport   │
                         │  │  src/lib/heuristics.ts      │  (score 0–100, level, findings)     │
                         │  └─────────────┬───────────────┘                                    │
                         │                ▼                                                     │
                         │  ┌──────────── AI ─────────────┐                                    │
                         │  │ explainTransaction()        │  buildPrompt() + provider switch    │
                         │  │  src/lib/ai.ts              │  → AiExplanation (placeholder today)│
                         │  └─────────────┬───────────────┘                                    │
                         │                ▼                                                     │
                         │           ReviewResult  ◄── { request, transaction, risk, explanation }│
  ResultView   ◄──JSON── │           NextResponse.json(result)                                 │
 RiskBadge               │                                                                    │
                         └──────────────────────────────────────────────────────────────────┘
```

In code terms the pipeline is exactly:

```
RPC fetch → parse() → assessRisk() → explainTransaction() → ReviewResult
```

orchestrated by `reviewTransaction(request)` in `src/lib/review.ts` and exposed at
`POST /api/review`. Every stage is pure and synchronous except the two I/O boundaries (the RPC
fetch and the future LLM call), which keeps the system easy to reason about and trivial to test.

---

## 2. Tech stack & rationale

| Layer | Choice | Version |
| --- | --- | --- |
| Runtime | Node.js LTS | 24.16.0 (npm 11.16.0) |
| Framework | Next.js (App Router) | 16.2.7 |
| UI | React | 19.2.7 |
| Language | TypeScript | 6.0.3 |
| Styling | Tailwind CSS (CSS-first) | 4.3.0 |
| Solana client | `@solana/web3.js` (v1 line) | 1.98.4 |

The broader Solana toolchain on the build machine was also brought current — **Rust 1.96.0**,
**Agave/Solana CLI 4.0.1**, **Anchor 1.0.2** — but none of those are used by this read-only web app.
They are listed only to record that the environment is up to date; the reviewer ships no on-chain
program.

### Next.js 16 (App Router)

The App Router gives us colocated server endpoints (route handlers) and server-only execution
without a separate backend service. The single route at `src/app/api/review/route.ts` pins
`export const runtime = "nodejs"` (the `@solana/web3.js` `Connection` depends on Node APIs and is
not Edge-safe) and `export const dynamic = "force-dynamic"` (each review is a fresh RPC fetch and
must never be statically cached). The client page (`src/app/page.tsx`) is the only piece that runs
in the browser, and it only ever does a `fetch("/api/review")` — it has no direct RPC access.

### `@solana/web3.js` v1 and `getParsedTransaction` vs v2 / `@solana/kit`

We use the **v1 line** (`@solana/web3.js@1.98.4`) specifically for `Connection.getParsedTransaction`.
That single call returns a `ParsedTransactionWithMeta` in which the RPC has already decoded
well-known programs (System, SPL Token, etc.) into `{ program, parsed: { type, info } }` shapes.
This is the heart of the PoC: the heuristics key off `parsedType` values like `setAuthority`,
`approve`, `closeAccount`, and `assign` (see `src/lib/heuristics.ts`), and `info` objects supply the
human-readable evidence. Reproducing that decoding ourselves would be a large undertaking.

The successor, **`@solana/kit` 6.x** (the rebranded `@solana/web3.js` v2), is a tree-shakable,
functional API that is excellent for building and sending transactions. For a read-only analyzer it
brings no benefit here and would cost us the convenient parsed-instruction path. The trade-off:

- **v1 `getParsedTransaction`** — batteries-included RPC parsing, slightly heavier bundle, the API
  surface this PoC is built on. *Chosen.*
- **v2 / `@solana/kit`** — smaller, modern, composable, but parsing of inner instructions and SPL
  types is more manual. *Noted as a future migration option*, not needed for read-only review.

Because the whole codebase reads only the normalized `ParsedTransaction` shape (never raw RPC
types) outside of `src/lib/parse.ts` and `src/lib/solana.ts`, a future swap to `@solana/kit` is
isolated to those two files.

### Tailwind CSS 4 (CSS-first config)

Tailwind v4 uses a CSS-first configuration: styles are pulled in via `@import "tailwindcss"` in
`src/app/globals.css`, with `@tailwindcss/postcss` wired through PostCSS. There is intentionally
**no `tailwind.config.js`** — theme tokens live in CSS. This keeps the styling layer minimal and
matches the "small surface area" goal of the PoC.

### Node 24 LTS

The project targets Node 24 LTS for the server runtime. `tsconfig.json` compiles to `ES2020` with
`moduleResolution: "bundler"`, `strict: true`, and the `@/*` path alias mapping to `./src/*`
(used by the API route's `@/lib/...` imports). Node 24 gives us a current, supported baseline with
no transpilation surprises for the server-only `@solana/web3.js` code.

---

## 3. Data model — the shared contract

Everything in the app speaks one vocabulary, defined once in **`src/lib/types.ts`**. The fetch
layer, the parser, the risk engine, the UI, and the (future) LLM all read and write these exact
interfaces. A single shared contract is what makes the pipeline composable: each stage is a pure
function from one well-typed shape to the next, and a change to the model is caught by the compiler
everywhere at once.

The key interfaces:

### `ParsedTransaction` — the normalized, UI-ready view

The output of `parseTransaction()` and the input to every downstream stage. It flattens the raw RPC
response into a stable shape:

```ts
interface ParsedTransaction {
  signature: string;
  cluster: string;
  slot: number;
  blockTime: number | null;
  success: boolean;              // err === null
  err: unknown | null;
  feeLamports: number;
  feeSol: number;
  computeUnitsConsumed?: number;
  recentBlockhash: string;
  feePayer: string;              // account index 0
  accounts: AccountSummary[];    // per-account role + net SOL movement
  signers: string[];
  writableAccounts: string[];
  instructions: InstructionSummary[];   // top-level + flattened inner (CPI)
  logMessages: string[];
  tokenBalanceChanges: TokenBalanceChange[];
  programsInvoked: ProgramInvocation[];
  version: "legacy" | number;
}
```

It is composed of four supporting record types, also in `types.ts`:

- **`AccountSummary`** — `index`, `pubkey`, `signer`, `writable`, `isProgram`, and net SOL movement
  (`solChangeLamports` / `solChangeSol`, computed as post − pre).
- **`InstructionSummary`** — a normalized instruction (top-level or inner CPI): `programId`,
  optional registry `programName`, the RPC's `program` label and `parsedType`, referenced
  `accounts`, the raw `info` object (evidence), plus `isInner` / `parentIndex`.
- **`TokenBalanceChange`** — a single SPL token account delta between pre and post state: `account`,
  `owner`, `mint`, `decimals`, raw `preAmount` / `postAmount` (base-unit strings), decimal-adjusted
  `uiPreAmount` / `uiPostAmount`, and `delta`.
- **`ProgramInvocation`** — `{ programId, name?, count }`, aggregated across top-level + inner
  instructions.

### `RiskReport` — the deterministic risk verdict

The output of `assessRisk()`:

```ts
interface RiskReport {
  score: number;             // 0–100, higher = riskier
  level: RiskLevel;          // "info" | "low" | "medium" | "high"; = the MAX finding level
  findings: RiskFinding[];   // sorted high → info
  summary: string;
}
```

Each `RiskFinding` carries a stable `id` (e.g. `"FULL_TOKEN_ACCOUNT_DRAIN"`), a `title`, a `level`,
a `detail` paragraph, and human-readable `evidence`. The stable IDs are deliberately part of the
contract: they are what the UI keys off and what an agent could pattern-match on.

### `AiExplanation` — the natural-language layer

```ts
interface AiExplanation {
  provider: "placeholder" | "openai" | "anthropic";
  model?: string;
  summary: string;       // plain-English narrative
  bullets: string[];     // key actions
  caveats: string[];     // disclaimers
  generatedAt: string;
}
```

The `provider` discriminant means the UI can always tell the user whether the explanation came from
the deterministic template (`"placeholder"`) or a real LLM, without any other code change.

### `ReviewResult` — the API response envelope

```ts
interface ReviewResult {
  request: ReviewRequest;        // echo of { signature, cluster, rpcUrl }
  transaction: ParsedTransaction;
  risk: RiskReport;
  explanation: AiExplanation;
}
```

This is exactly what `reviewTransaction()` returns and what `POST /api/review` serializes. The
client renders it directly — no second contract between server and browser.

`ReviewRequest` (the input side) is the small `{ signature, cluster?, rpcUrl? }` shape the client
posts, with `cluster` typed as `"mainnet-beta" | "devnet" | "testnet"`.

---

## 4. Module responsibilities

Each file under `src/lib/` owns one stage or one concern. Dependencies flow strictly downward —
nothing in `lib/` imports from the UI or the route.

### `src/lib/types.ts`
The shared data model described in §3. No logic, only the contract every other module depends on.

### `src/lib/programs.ts`
A small, curated registry of well-known program IDs → `{ name, category }` (`KNOWN_PROGRAMS`),
covering System, SPL Token / Token-2022 / Associated Token, Compute Budget, both Memo programs, the
BPF loaders, Stake, Vote, Metaplex Token Metadata, Jupiter v6, Raydium v4, Orca Whirlpools, and
pump.fun. Exposes `resolveProgram(programId)` (friendly name lookup) and `isKnownProgram(programId)`
(used by the unknown-program heuristic). Intentionally minimal and trivial to extend.

### `src/lib/format.ts`
Pure, shared formatting helpers used by both server and UI: `LAMPORTS_PER_SOL`, `lamportsToSol`,
`formatSol` (trims trailing zeros, 4dp ≥ 1 SOL else 9dp), `shortPubkey` (base58 abbreviation),
`formatTokenAmount`, and `isLikelyPubkey` (base58 shape check, also used by the parser to surface
account-shaped values out of parsed `info`).

### `src/lib/solana.ts`
The read-only RPC access layer. `resolveRpcUrl(cluster, rpcUrl?)` implements endpoint precedence
(see §5); `getConnection()` builds a `Connection` at `"confirmed"`; `isValidSignature()` does cheap
base58 structural validation; and `fetchParsedTransaction()` calls
`connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })`
and returns `ParsedTransactionWithMeta | null`. **This is the only module that talks to the chain,
and it only ever reads.**

### `src/lib/parse.ts`
The deterministic extraction layer. `parseTransaction(raw, signature, cluster)` normalizes the raw
RPC response into `ParsedTransaction`:

- **SOL deltas** — per account, `postBalances[i] − preBalances[i]`.
- **Instruction flattening** — top-level instructions are interleaved with their inner (CPI)
  instructions via `meta.innerInstructions`, assigned a single sequential `index`, with `isInner`
  and `parentIndex` set. Parsed instructions surface `program` / `parsedType` / `info`; partially
  decoded ones surface their raw `accounts`.
- **`isProgram` marking** — any account whose pubkey appears as a `programId` is flagged.
- **Token balance changes** — `computeTokenBalanceChanges()` joins `preTokenBalances` and
  `postTokenBalances` by `accountIndex`, drops unchanged entries, and sorts by `|delta|`.
- **`programsInvoked`** — counts per program across top-level + inner, sorted by count.

Everything downstream reads this normalized shape and never the raw RPC types.

### `src/lib/heuristics.ts`
The deterministic risk engine. `assessRisk(tx)` runs an array of pure rule functions, collects
`RiskFinding`s, and aggregates them into a `RiskReport`. Details and the full rule list are in §4.1.

### `src/lib/ai.ts`
The natural-language layer and the LLM seam. `buildPrompt(tx, risk)` produces the exact structured
context a real LLM would receive; `explainTransaction(tx, risk, options)` contains the provider
switch and today returns a deterministic `placeholderExplanation()`. See §6.

### `src/lib/review.ts`
The orchestrator. `reviewTransaction(request)` runs the full pipeline — validate → fetch → parse →
assess → explain — and assembles the `ReviewResult`. It owns input validation and error mapping via
the `ReviewError` class, which carries an HTTP `status` (400 invalid signature, 404 not found, 502
RPC error) for the API layer to translate.

### `src/app/api/review/route.ts`
The HTTP boundary. `POST /api/review` parses the JSON body (`{ signature, cluster?, rpcUrl? }`),
calls `reviewTransaction()`, and returns `ReviewResult` as JSON. `ReviewError` instances map to
their carried status; anything else becomes a 500. Pinned to `runtime = "nodejs"` and
`dynamic = "force-dynamic"`.

### 4.1 Risk heuristics in detail

`assessRisk()` is a clamped weighted sum over independent rules. The mechanics, verbatim from
`src/lib/heuristics.ts`:

- **Per-level weight** (`LEVEL_WEIGHT`): `info = 0`, `low = 10`, `medium = 25`, `high = 45`.
- **Score** = `clamp(Σ weights, 0, 100)`.
- **Overall `level`** = the **maximum** individual finding level (by rank info < low < medium < high).
- **Findings** are sorted high → info before being returned; `summary` reports the counts per level.

Tunable `THRESHOLDS`:

| Threshold | Value |
| --- | --- |
| `largeSolOutflow` | 1 SOL |
| `veryLargeSolOutflow` | 10 SOL |
| `manyWritableAccounts` | 12 |
| `highFeeSol` | 0.01 SOL |
| `largeTokenOutflowPct` | 0.5 (fraction of pre-balance) |

The rules (`id` | level | trigger):

| ID | Level | Trigger |
| --- | --- | --- |
| `TX_FAILED` | info | `meta.err != null` |
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
| `MULTIPLE_SIGNERS` | info | more than 1 signer |
| `COMPUTE_BUDGET_SET` | info | Compute Budget program used |
| `MEMO_PRESENT` | info | Memo program used |

These are **explainable signals, not a verdict**. They surface the patterns a careful reviewer
would look for — drains, authority handovers, delegate approvals, unknown programs — and each
finding carries `detail` and `evidence` text so the user can judge for themselves.

---

## 5. RPC strategy

### Endpoint resolution precedence

`resolveRpcUrl(cluster, rpcUrl?)` in `src/lib/solana.ts` picks the endpoint in this order:

1. **Explicit `rpcUrl`** from the request (e.g. a Helius/QuickNode URL pasted in the UI) — wins if
   present and non-empty.
2. **`SOLANA_RPC_URL` env var** — used **only for `mainnet-beta`** (deliberately kept off
   devnet/testnet so a mainnet endpoint can't be accidentally hit for the wrong cluster).
3. **The public cluster default** — `api.mainnet-beta.solana.com`, `api.devnet.solana.com`, or
   `api.testnet.solana.com`.

This lets the PoC run with zero configuration on public RPC while making it trivial to plug in a
private endpoint for reliability.

### `maxSupportedTransactionVersion` and parsed vs raw

`fetchParsedTransaction()` calls `getParsedTransaction` with
`{ maxSupportedTransactionVersion: 0, commitment: "confirmed" }`. Setting
`maxSupportedTransactionVersion: 0` is required to fetch **versioned (v0) transactions** — without
it, the RPC throws on any transaction that uses address lookup tables, which covers a large share of
modern DeFi activity. We use the **parsed** variant (not `getTransaction`) on purpose: the RPC
decodes known programs into `{ program, parsed: { type, info } }`, which is exactly what the
heuristics and evidence text rely on. The normalized `version` field on `ParsedTransaction` records
`"legacy"` or the numeric version for display.

### Rate-limit handling & custom RPC

Public RPC endpoints rate-limit aggressively and prune older transactions. The mitigations are
layered:

- A `null` return from `getParsedTransaction` (signature unknown to this RPC — too old, wrong
  cluster, or not yet confirmed) is mapped by `reviewTransaction()` to a **404** with an
  actionable message.
- Any thrown RPC error (including rate-limit responses) is caught and mapped to a **502** so the
  user sees a clear "RPC error" rather than an opaque crash.
- The **custom `rpcUrl` passthrough** (precedence rule 1) and the `SOLANA_RPC_URL` env var both let
  the operator or user point at a private, higher-limit endpoint that retains historical
  transactions.

---

## 6. The AI seam

### How the placeholder is structured

`explainTransaction(tx, risk, options)` in `src/lib/ai.ts` is the single entry point for the
natural-language layer. It resolves the provider from, in order: an explicit `options.provider`, the
`AI_PROVIDER` env var, or the default `"placeholder"`. Today it always returns
`placeholderExplanation(tx, risk)` — a deterministic, template-based `AiExplanation` assembled
entirely from the parsed transaction and the risk report. The placeholder:

- builds a plain-English `summary` (status, cluster, time, signer count, fee, programs, token-change
  count, and the deterministic risk verdict),
- emits `bullets` for status/fee, fee payer, programs, the top SOL movements, and the top token
  balance changes,
- and attaches fixed `caveats` making clear that **this is a rule-based engine, not an LLM**, and
  that the heuristics are signals, not financial advice.

This means the PoC runs with **zero API keys and zero cost** while still producing a useful, honest
explanation — and the `provider: "placeholder"` field tells the UI exactly what generated it.

Crucially, `buildPrompt(tx, risk)` is already implemented as a pure, exported function. It returns
the exact structured context a real LLM would receive: signature, cluster/slot/success, fee and fee
payer, signers, programs (`name x count`), the full token balance changes, a compact instruction
list (`program` + `type`), and the deterministic risk line (`level`, `score`, finding IDs). The
prompt instructs the model to **only use the facts provided — never invent addresses, amounts, or
intent**, which keeps the LLM grounded in the deterministic extraction.

### Connecting OpenAI / Anthropic — exact steps

The seam is intentionally narrow. To go from placeholder to a real LLM:

1. **Set the provider** — `AI_PROVIDER=openai` or `AI_PROVIDER=anthropic` (or pass
   `options.provider`), and add the corresponding API key as a server-side env var. The key lives
   only on the Node runtime; it is never sent to the browser.
2. **Implement the provider call** — inside the existing
   `if (provider === "openai" || provider === "anthropic")` branch in `explainTransaction()`, where
   the code today documents the shape:

   ```ts
   const prompt = buildPrompt(tx, risk);
   const text = await callProvider(provider, prompt); // OpenAI / Anthropic SDK
   return {
     provider, model,
     summary: text,
     bullets: [...], caveats: [...],
     generatedAt: new Date().toISOString(),
   };
   ```

3. **Keep the graceful fallback** — if no key is configured (or the call fails), the branch falls
   through to `placeholderExplanation()`, so the app always returns a valid `AiExplanation` and
   never hard-fails on a missing key. No other module changes, because every consumer reads the same
   `AiExplanation` contract.

### The agentic future

The deterministic core is designed to be the grounded base an LLM agent can build on. Because the
extraction is already structured and the risk findings carry stable IDs, a tool-calling agent is a
natural next layer. Such an agent could, on top of `buildPrompt()`'s context, call read-only tools
to enrich its reasoning:

- **Mint metadata** — resolve a `mint` to its symbol, name, and decimals (e.g. via Metaplex Token
  Metadata or a token list) so token changes read as "100 USDC" rather than a raw amount.
- **Program IDLs / identity** — fetch an Anchor IDL or a verified-program registry to name an
  otherwise `UNKNOWN_PROGRAM` and decode its instructions.
- **Prior history** — pull the fee payer's or a counterparty's recent activity to flag first-time
  interactions or known-bad addresses.

All of these remain **read-only**, and all would feed back through the same `AiExplanation`
contract. The deterministic heuristics stay the trustworthy floor; the agent adds context and
explanation on top, never replacing the signals with an unverifiable judgment.

---

## 7. Security & limitations

### Read-only by construction

The app only ever calls `getParsedTransaction`. There is no keypair, no signing, no sending, and no
write path anywhere in the codebase. The worst-case action is fetching and displaying a transaction
that already happened.

### The `rpcUrl` passthrough (SSRF consideration)

The client can supply an arbitrary `rpcUrl`, which the server then fetches — a classic
**server-side request forgery (SSRF)** surface if left unguarded. The PoC ships a baseline guard:
`assertSafeRpcUrl()` in `src/lib/solana.ts` requires an `http(s)` URL and **rejects loopback,
private (RFC 1918), link-local `169.254.0.0/16` (cloud metadata), `0.0.0.0`, `localhost`, and
`*.local`/`*.internal` hosts**. `reviewTransaction()` calls it before any fetch and returns a **400**
on violation (verified: `http://169.254.169.254/...` → `400 "RPC URL host is not allowed."`).
**For production** this should be tightened further to a positive allowlist of known RPC hosts (or
custom-RPC selection moved entirely server-side behind `SOLANA_RPC_URL`), plus DNS-rebinding
protection. The baseline guard closes the obvious vectors; the allowlist is listed as future work.

### Input validation

`isValidSignature()` does cheap base58 structural validation (length 64–90, base58 alphabet) before
any RPC call, and `reviewTransaction()` rejects bad input with a 400 before reaching the network.
The route also guards against malformed JSON bodies (400). Validation is intentionally cheap and
fail-fast; the RPC itself is the final arbiter of whether a signature actually exists.

### No secrets in the client

All RPC and any future LLM credentials live as **server-side env vars** (`SOLANA_RPC_URL`,
`AI_PROVIDER`, provider keys) and are only read on the Node runtime. The browser never holds a key;
it only POSTs to `/api/review`. The route is pinned to `runtime = "nodejs"`, so this code never runs
at the Edge where env handling differs.

### Error handling

`ReviewError` carries an HTTP `status` so failures map to meaningful codes — 400 (invalid
signature / bad JSON), 404 (transaction not found / pruned / wrong cluster), 502 (RPC error) — and
any unexpected error becomes a 500 with its message. The user always gets an actionable string, not
a stack trace.

### Honest limitations

- **Public RPC** rate-limits and prunes older transactions; custom RPC (input or env) is the
  escape hatch.
- **Heuristics are signals, not verdicts** — every finding says so in its `detail`/`caveats`.
- **No persistence** — each review is stateless; nothing is stored.
- **No real LLM yet** — the explanation is a deterministic placeholder; the provider switch is
  ready but unwired.

---

## 8. Testing & extension

### Testing approach

The architecture is built for testability: every stage except the two I/O boundaries is a **pure
function** over the shared types, so it can be unit-tested with fixture data and no network.

- **Heuristics (`assessRisk`)** — the highest-value tests. Feed hand-built `ParsedTransaction`
  fixtures (a clean transfer, a full token drain, a `setAuthority`, an unknown-program call, etc.)
  and assert the expected finding `id`s, the `level`, and the `score`. Because each rule is an
  independent pure function and the score math is a fixed weighted sum, these are deterministic and
  fast.
- **Parser (`parseTransaction`)** — capture a real `getParsedTransaction` response as a JSON
  fixture and assert the normalized output: SOL deltas, the flattened instruction order (top-level
  + inner with correct `parentIndex`), token balance changes, and `programsInvoked` counts.
- **Formatters (`src/lib/format.ts`)** — straightforward pure-function tests for `formatSol`,
  `shortPubkey`, `formatTokenAmount`, and the `isLikelyPubkey` predicate.
- **Prompt builder (`buildPrompt`)** — assert the prompt string contains the expected grounded
  facts; it is exported precisely so it can be tested independently of any provider.
- **API route** — exercise `POST /api/review` against the validation and error paths: invalid
  signature → 400, malformed JSON → 400, unknown signature → 404, RPC failure → 502.

`package.json` already exposes `npm run typecheck` (`tsc --noEmit`) and `npm run lint`; under
`strict` TypeScript, the shared contract means a model change surfaces as compile errors across
every consumer before any test runs.

### Extending the heuristics

Adding a rule is a three-line change in `src/lib/heuristics.ts`:

1. Write a pure `check*(tx: ParsedTransaction)` function returning a `RiskFinding`,
   `RiskFinding[]`, or `null`. Give it a **stable `id`**, a `level`, and a `detail` plus `evidence`
   so it stays explainable.
2. Add it to the `RULES` array.
3. Tune any new constant in the `THRESHOLDS` object.

The aggregator (`score`, overall `level`, sorting, `summary`) picks it up automatically — no other
code changes. To change sensitivity, adjust `THRESHOLDS` or the `LEVEL_WEIGHT` map.

### Extending the program registry

To recognize a new program, add an entry to `KNOWN_PROGRAMS` in `src/lib/programs.ts` mapping its
base58 ID to `{ name, category }`. That immediately gives every matching instruction a friendly
`programName`, removes it from the `UNKNOWN_PROGRAM` finding, and lets name-based rules (e.g. the
Compute Budget / Memo / BPF-loader checks) match on it. The registry is intentionally a small,
curated set so it stays trustworthy and is easy to audit.

---

## Grant context & contact

Built for the **Superteam Agentic Engineering Grant** (~200 USDG). Audience: Solana users and
developers who want to **understand and sanity-check transactions before or after signing**. Value:
safer signing, faster debugging, and an explainable, read-only base that a real agent can plug into.

<!-- CONTACT / LINKS PLACEHOLDER — add repository URL, demo link, and author contact here. -->
