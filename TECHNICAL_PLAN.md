# Solana Agentic Transaction Reviewer (Technical Plan)

> A lightweight, AI-assisted, **read-only** Solana transaction review tool. You can review a
> transaction two ways. Paste a confirmed signature and the app fetches it over RPC. Or paste an
> unsigned, base64 transaction and the app simulates it before you ever sign. Either way it extracts
> metadata, accounts, instructions, and token balance changes, runs deterministic risk heuristics,
> and produces a human-readable explanation plus a risk report.
>
> I built this proof-of-concept for the **Superteam Agentic Engineering Grant** (~200 USDG). The
> scope is deliberately small. It does read-only analysis. There is **no new protocol**, and the app
> **never signs or sends** anything.

---

## Table of contents

1. [System overview & pipeline](#1-system-overview--pipeline)
2. [Tech stack & rationale](#2-tech-stack--rationale)
3. [Data model (the shared contract)](#3-data-model-the-shared-contract)
4. [Module responsibilities](#4-module-responsibilities)
5. [Pre-sign simulation](#5-pre-sign-simulation)
6. [Token metadata enrichment](#6-token-metadata-enrichment)
7. [RPC strategy](#7-rpc-strategy)
8. [The AI seam](#8-the-ai-seam)
9. [Security & limitations](#9-security--limitations)
10. [Testing & extension](#10-testing--extension)
11. [Roadmap](#11-roadmap)

---

## 1. System overview & pipeline

The reviewer is a single Next.js application with a thin client UI and one server endpoint. All
on-chain work happens server-side. The `@solana/web3.js` client needs Node APIs, and I never expose
RPC credentials to the browser. The flow is a straight, deterministic pipeline. There are two ways
in, and they converge on one shared shape:

```
                         ┌──────────────────────────────────────────────────────────────────┐
  Browser                │                         Node.js server                            │
 (page.tsx)              │                                                                    │
                         │                                                                    │
  signature OR ──POST──► │  src/app/api/review/route.ts                                       │
  rawTransaction         │      │  validates JSON body                                        │
  cluster                │      ▼                                                              │
  rpcUrl?                │  src/lib/review.ts  reviewTransaction(request)                     │
                         │      │                                                              │
                         │      ├── signature ──► fetchParsedTransaction() ─► parseTransaction()│
                         │      │                  (src/lib/solana.ts)        (src/lib/parse.ts)│
                         │      │                                                              │
                         │      └── rawTransaction ──► simulateAndReview()                     │
                         │                              (src/lib/presign.ts)                   │
                         │                ▼                                                     │
                         │           ParsedTransaction  (one shared shape; simulated:true|false)│
                         │                ▼                                                     │
                         │  ┌──────── ENRICH ─────────────┐                                    │
                         │  │ enrichTokenMetadata()       │  mint → { symbol, name, logoURI }   │
                         │  │  src/lib/metadata.ts        │  (never throws)                     │
                         │  └─────────────┬───────────────┘                                    │
                         │                ▼                                                     │
                         │  ┌────────── HEURISTICS ───────┐                                    │
                         │  │ assessRisk()                │  deterministic rules → RiskReport   │
                         │  │  src/lib/heuristics.ts      │  (score 0–100, level, findings)     │
                         │  └─────────────┬───────────────┘                                    │
                         │                ▼                                                     │
                         │  ┌──────────── AI ─────────────┐                                    │
                         │  │ explainTransaction()        │  buildPrompt() + provider switch    │
                         │  │  src/lib/ai.ts              │  → AiExplanation                    │
                         │  └─────────────┬───────────────┘                                    │
                         │                ▼                                                     │
                         │           ReviewResult  ◄── { request, transaction, risk, explanation }│
  ResultView   ◄──JSON── │           NextResponse.json(result)                                 │
 RiskBadge               │                                                                    │
                         └──────────────────────────────────────────────────────────────────┘
```

In code terms the confirmed path is exactly:

```
RPC fetch → parse() → enrich → assessRisk() → explainTransaction() → ReviewResult
```

and the pre-sign path is:

```
simulateAndReview() → enrich → assessRisk() → explainTransaction() → ReviewResult
```

Both are orchestrated by `reviewTransaction(request)` in `src/lib/review.ts` and exposed at
`POST /api/review`. Every stage is pure and synchronous except the I/O boundaries (the RPC fetch,
the simulation, the metadata lookup, and the LLM call). That keeps the system easy to reason about
and easy to test. The key design choice is that the pre-sign path emits the **same**
`ParsedTransaction` the confirmed path produces. The risk engine, the explanation, and the UI do
not know or care which path produced the data.

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

I also brought the broader Solana toolchain on the build machine current (**Rust 1.96.0**,
**Agave/Solana CLI 4.0.1**, **Anchor 1.0.2**), but none of those are used by this read-only web app.
They are listed only to record that the environment is up to date. The reviewer ships no on-chain
program.

### Next.js 16 (App Router)

The App Router gives me colocated server endpoints (route handlers) and server-only execution
without a separate backend service. The single route at `src/app/api/review/route.ts` pins
`export const runtime = "nodejs"` (the `@solana/web3.js` `Connection` depends on Node APIs and is
not Edge-safe) and `export const dynamic = "force-dynamic"` (each review is a fresh RPC fetch and
must never be statically cached). The client page (`src/app/page.tsx`) is the only piece that runs
in the browser, and it only ever does a `fetch("/api/review")`. It has no direct RPC access.

### `@solana/web3.js` v1 and `getParsedTransaction` vs v2 / `@solana/kit`

I use the **v1 line** (`@solana/web3.js@1.98.4`) specifically for `Connection.getParsedTransaction`.
That single call returns a `ParsedTransactionWithMeta` in which the RPC has already decoded
well-known programs (System, SPL Token, and so on) into `{ program, parsed: { type, info } }` shapes.
This is the heart of the PoC. The heuristics key off `parsedType` values like `setAuthority`,
`approve`, `closeAccount`, and `assign` (see `src/lib/heuristics.ts`), and `info` objects supply the
human-readable evidence. Reproducing that decoding myself would be a large undertaking.

The successor, **`@solana/kit` 6.x** (the rebranded `@solana/web3.js` v2), is a tree-shakable,
functional API that is excellent for building and sending transactions. For a read-only analyzer it
brings no benefit here, and it would cost me the convenient parsed-instruction path. The trade-off:

- **v1 `getParsedTransaction`** (batteries-included RPC parsing, slightly heavier bundle, the API
  surface this PoC is built on). *Chosen.*
- **v2 / `@solana/kit`** (smaller, modern, composable, but parsing of inner instructions and SPL
  types is more manual). *Noted as a future migration option*, not needed for read-only review.

Because the whole codebase reads only the normalized `ParsedTransaction` shape (never raw RPC
types) outside of `src/lib/parse.ts`, `src/lib/presign.ts`, and `src/lib/solana.ts`, a future swap to
`@solana/kit` is isolated to those files.

### Tailwind CSS 4 (CSS-first config)

Tailwind v4 uses a CSS-first configuration. Styles are pulled in via `@import "tailwindcss"` in
`src/app/globals.css`, with `@tailwindcss/postcss` wired through PostCSS. There is intentionally
**no `tailwind.config.js`**. Theme tokens live in CSS. This keeps the styling layer minimal and
matches the small-surface-area goal of the PoC.

### Node 24 LTS

The project targets Node 24 LTS for the server runtime. `tsconfig.json` compiles to `ES2020` with
`moduleResolution: "bundler"`, `strict: true`, and the `@/*` path alias mapping to `./src/*`
(used by the API route's `@/lib/...` imports). Node 24 gives me a current, supported baseline with
no transpilation surprises for the server-only `@solana/web3.js` code.

---

## 3. Data model (the shared contract)

Everything in the app speaks one vocabulary, defined once in **`src/lib/types.ts`**. The fetch
layer, the simulator, the parser, the metadata module, the risk engine, the UI, and the LLM all read
and write these exact interfaces. A single shared contract is what makes the pipeline composable.
Each stage is a pure function from one well-typed shape to the next, and a change to the model is
caught by the compiler everywhere at once.

The key interfaces:

### `ParsedTransaction` (the normalized, UI-ready view)

This is the output of both `parseTransaction()` (confirmed) and `simulateAndReview()` (pre-sign),
and the input to every downstream stage. It flattens the raw RPC response into a stable shape:

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
  simulated?: boolean;           // true when produced by the pre-sign path
}
```

It is composed of four supporting record types, also in `types.ts`:

- **`AccountSummary`** has `index`, `pubkey`, `signer`, `writable`, `isProgram`, and net SOL movement
  (`solChangeLamports` / `solChangeSol`, computed as post minus pre).
- **`InstructionSummary`** is a normalized instruction (top-level or inner CPI): `programId`,
  optional registry `programName`, the `program` label and `parsedType`, referenced
  `accounts`, the raw `info` object (evidence), plus `isInner` / `parentIndex`.
- **`TokenBalanceChange`** is a single SPL token account delta between pre and post state: `account`,
  `owner`, `mint`, `decimals`, optional resolved `symbol` / `name` / `logoURI`, raw `preAmount` /
  `postAmount` (base-unit strings), decimal-adjusted `uiPreAmount` / `uiPostAmount`, and `delta`.
- **`ProgramInvocation`** is `{ programId, name?, count }`, aggregated across top-level + inner
  instructions.

### `RiskReport` (the deterministic risk verdict)

The output of `assessRisk()`:

```ts
interface RiskReport {
  score: number;             // 0–100, higher = riskier
  level: RiskLevel;          // "info" | "low" | "medium" | "high"; = the MAX finding level
  findings: RiskFinding[];   // sorted high → info
  summary: string;
}
```

Each `RiskFinding` carries a stable `id` (for example `"FULL_TOKEN_ACCOUNT_DRAIN"`), a `title`, a
`level`, a `detail` paragraph, and human-readable `evidence`. The stable IDs are deliberately part
of the contract. They are what the UI keys off and what an agent could pattern-match on.

### `AiExplanation` (the natural-language layer)

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

### `ReviewResult` (the API response envelope)

```ts
interface ReviewResult {
  request: ReviewRequest;        // echo of { signature?, cluster, rpcUrl? }
  transaction: ParsedTransaction;
  risk: RiskReport;
  explanation: AiExplanation;
}
```

This is exactly what `reviewTransaction()` returns and what `POST /api/review` serializes. The
client renders it directly. There is no second contract between server and browser.

`ReviewRequest` (the input side) is the small shape the client posts. You provide **exactly one** of
`signature` or `rawTransaction`, plus an optional `cluster` and `rpcUrl`:

```ts
interface ReviewRequest {
  signature?: string;       // confirmed transaction (post-hoc path)
  rawTransaction?: string;  // base64-serialized UNSIGNED transaction (pre-sign path)
  cluster?: Cluster;        // "mainnet-beta" | "devnet" | "testnet"
  rpcUrl?: string;
}
```

---

## 4. Module responsibilities

Each file under `src/lib/` owns one stage or one concern. Dependencies flow strictly downward.
Nothing in `lib/` imports from the UI or the route.

### `src/lib/types.ts`
The shared data model described in §3. No logic, only the contract every other module depends on.

### `src/lib/programs.ts`
A small, curated registry of well-known program IDs mapped to `{ name, category }`
(`KNOWN_PROGRAMS`), covering System, SPL Token / Token-2022 / Associated Token, Compute Budget, both
Memo programs, the BPF loaders, Stake, Vote, Metaplex Token Metadata, Jupiter (v4/v6), Raydium
(v4/CLMM/CPMM), Orca Whirlpools, Meteora (DLMM/DAMM v2), Phoenix, Lifinity v2, pump.fun, PumpSwap,
and Jito Tip Payment. It exposes `resolveProgram(programId)` (friendly name lookup),
`isKnownProgram(programId)` (used by the unknown-program heuristic), and `isDexProgram(programId)`
(used by the swap-aware token rules). It is intentionally minimal and trivial to extend.

### `src/lib/watchlist.ts`
A curated, best-effort, non-exhaustive watchlist of flagged addresses and programs. Each entry
carries a `label`, a `category` (`drainer` | `scam` | `phishing` | `sanctioned` | `burn`), and a
citable `source`. The matching is fully wired through `lookupWatch(address)`, so the list grows
without code changes. This is not financial advice and not a judgment that any address is malicious.
The default list ships only the well-known SOL burn/incinerator address.

### `src/lib/format.ts`
Pure, shared formatting helpers used by both server and UI: `LAMPORTS_PER_SOL`, `lamportsToSol`,
`formatSol` (trims trailing zeros, 4dp at or above 1 SOL else 9dp), `shortPubkey` (base58
abbreviation), `formatTokenAmount`, and `isLikelyPubkey` (base58 shape check, also used by the
parser to surface account-shaped values out of parsed `info`).

### `src/lib/solana.ts`
The read-only RPC access layer. `resolveRpcUrl(cluster, rpcUrl?)` implements endpoint precedence
(see §7). `getConnection()` builds a `Connection` at `"confirmed"`. `isValidSignature()` does cheap
base58 structural validation. `fetchParsedTransaction()` calls
`connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })`
and returns `ParsedTransactionWithMeta | null`. **This module talks to the chain, and it only ever
reads.**

### `src/lib/parse.ts`
The deterministic extraction layer for the confirmed path. `parseTransaction(raw, signature, cluster)`
normalizes the raw RPC response into `ParsedTransaction`:

- **SOL deltas** are per account, `postBalances[i] − preBalances[i]`.
- **Instruction flattening** interleaves top-level instructions with their inner (CPI)
  instructions via `meta.innerInstructions`, assigns a single sequential `index`, and sets `isInner`
  and `parentIndex`. Parsed instructions surface `program` / `parsedType` / `info`. Partially
  decoded ones surface their raw `accounts`.
- **`isProgram` marking** flags any account whose pubkey appears as a `programId`.
- **Token balance changes** come from `computeTokenBalanceChanges()`, which joins `preTokenBalances`
  and `postTokenBalances` by `accountIndex`, drops unchanged entries, and sorts by `|delta|`.
- **`programsInvoked`** counts per program across top-level + inner, sorted by count.

It also exports `rawToUi(raw, decimals)`, the shared base-unit to decimal-adjusted converter the
pre-sign path reuses. Everything downstream reads this normalized shape and never the raw RPC types.

### `src/lib/presign.ts`
The pre-sign extraction layer. `simulateAndReview(rawBase64, cluster, rpcUrl?)` deserializes an
unsigned transaction, simulates it read-only, and produces the same `ParsedTransaction` with
`simulated: true`. Full detail is in §5.

### `src/lib/metadata.ts`
Token metadata enrichment. `enrichTokenMetadata(changes)` resolves each `mint` to a symbol, name,
and logo. Full detail is in §6.

### `src/lib/heuristics.ts`
The deterministic risk engine. `assessRisk(tx)` runs an array of pure rule functions, collects
`RiskFinding`s, and aggregates them into a `RiskReport`. Details and the full rule list are in §4.1.

### `src/lib/ai.ts`
The natural-language layer and the LLM seam. `buildPrompt(tx, risk)` produces the exact structured
context a real LLM receives. `explainTransaction(tx, risk, options)` contains the provider switch.
It calls Anthropic or OpenAI when a provider and key are configured, and otherwise returns a
deterministic `placeholderExplanation()`. See §8.

### `src/lib/review.ts`
The orchestrator. `reviewTransaction(request)` runs the full pipeline (validate, then fetch-or-
simulate, then enrich, then assess, then explain) and assembles the `ReviewResult`. It owns input
validation and error mapping via the `ReviewError` class, which carries an HTTP `status` (400 invalid
input, 404 not found, 502 RPC error) for the API layer to translate. Pre-sign errors surface as a
`PresignError`, which `reviewTransaction()` re-wraps into a `ReviewError` carrying the same status.

### `src/app/api/review/route.ts`
The HTTP boundary. `POST /api/review` parses the JSON body (`{ signature?, rawTransaction?, cluster?,
rpcUrl? }`), calls `reviewTransaction()`, and returns `ReviewResult` as JSON. `ReviewError` instances
map to their carried status. Anything else becomes a 500. It is pinned to `runtime = "nodejs"` and
`dynamic = "force-dynamic"`.

### 4.1 Risk heuristics in detail

`assessRisk()` runs every rule, dedupes repeated findings by `id`, and scores the result with
diminishing returns. The mechanics, verbatim from `src/lib/heuristics.ts`:

- **Per-level weight** (`LEVEL_WEIGHT`): `info = 0`, `low = 10`, `medium = 25`, `high = 45`.
- **Score** uses diminishing returns per level. The k-th finding at a given level adds
  `weight * 0.5^k`, then the sum is `clamp(total, 0, 100)`. This stops busy-but-benign transactions
  from saturating at 100 while keeping stacked high-severity signals near the top.
- **Overall `level`** is the **maximum** individual finding level (by rank info < low < medium < high).
- **Findings** are deduped by `id` (merging evidence, tagging a `×count`), then sorted high to info
  before being returned. The `summary` reports the counts per level.

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
| `TX_FAILED` | info | `err != null` |
| `FLAGGED_ADDRESS` | high (or medium for `burn`) | any account/program matches the watchlist |
| `UNKNOWN_PROGRAM` | medium | invokes a program not in the registry |
| `LARGE_SOL_OUTFLOW` | medium (≥ 1 SOL) / high (≥ 10 SOL) | fee payer net SOL decrease |
| `FULL_TOKEN_ACCOUNT_DRAIN` | high | signer-owned token account pre > 0 and post == 0 |
| `LARGE_TOKEN_OUTFLOW` | low (≥ 50% of balance) / medium (≥ 90%) | partial token decrease |
| `TOKEN_SWAP` | low | a drain/outflow where the same owner got value back via a known DEX |
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

Two rules deserve a note. The token rules are **swap-aware**. They only count the signing user's own
token accounts (pool and vault accounts owned by program PDAs routinely zero out in a swap), they
exclude wrapped SOL (which the native SOL rules already cover), and when a known DEX ran and the same
owner received non-dust value back, the finding is relabeled `TOKEN_SWAP` rather than treated as a
drain. The relabel is defensive. A drainer that dusts a fake inflow still fails the guard, and an
unknown owner never qualifies, so the engine fails safe to the higher-risk drain finding.

These are **explainable signals, not a verdict**. They surface the patterns a careful reviewer would
look for: drains, authority handovers, delegate approvals, unknown programs, flagged addresses. Each
finding carries `detail` and `evidence` text so the user can judge for themselves.

---

## 5. Pre-sign simulation

This is the headline feature, and it is built and verified live. The confirmed path tells you what a
transaction **did**. The pre-sign path tells you what an unsigned transaction **would do** if you
signed and sent it right now. Nothing is ever signed or sent. This is simulation only.

`simulateAndReview(rawBase64, cluster, rpcUrl?)` in `src/lib/presign.ts` runs five steps and returns
the same `ParsedTransaction` the confirmed path produces, with `simulated: true`. The flow is:

1. **Deserialize.** Accept a base64-serialized `VersionedTransaction`, decode it, and bound the size
   (an empty buffer or one over 1644 bytes is rejected with a clear message). A bad input becomes a
   400.

2. **Resolve address lookup tables (v0).** If the message has `addressTableLookups`, fetch each table
   with `connection.getAddressLookupTable()` and pass the resolved `AddressLookupTableAccount`s into
   `message.getAccountKeys({ addressLookupTableAccounts })`. This expands the full account list,
   exactly as it would expand on-chain. From that list I derive signers and writable accounts via
   `message.isAccountSigner(i)` and `message.isAccountWritable(i)`.

3. **Fetch pre-state.** Call `connection.getMultipleAccountsInfo()` for the writable accounts. Only
   writable accounts can change, so those are the only ones worth diffing.

4. **Simulate read-only.** Call
   `connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true, accounts: { encoding: "base64", addresses: writableAccounts } })`.
   Signature verification is off, the blockhash is replaced, and I ask the RPC to return the
   post-state for the same writable accounts plus the inner instructions.

5. **Diff pre vs post.** Derive SOL deltas (`post.lamports − pre.lamports` per writable account) and
   SPL token deltas by reading the token account layout directly: the token amount is the u64 LE at
   byte 64, the mint is bytes 0..32, and the owner is bytes 32..64. For any changed mint I fetch the
   mint account and read its decimals at byte 44. The resulting `TokenBalanceChange`s are
   decimal-adjusted with the shared `rawToUi()` helper, so they are indistinguishable from the
   confirmed path's output.

### The instruction-type decoder

The confirmed path gets `parsedType` for free, because the RPC decodes known programs. The pre-sign
path does not. I have only the raw instruction data. So `decodeIxType()` recovers the instruction
**type** from the raw discriminator for the two program families the heuristics care about most:

- **SPL Token / Token-2022.** The first data byte is the instruction discriminator, mapped back to
  the parsed strings: `3 → transfer`, `4 → approve`, `6 → setAuthority`, `9 → closeAccount`,
  `13 → approveChecked`, and so on.
- **System.** The first 4 bytes are a u32 LE discriminator: `0 → createAccount`, `1 → assign`,
  `3 → createAccountWithSeed`, `8 → allocate`, and so on.

This is what lets the same `parsedType`-dependent heuristics (`setAuthority`, `approve`,
`closeAccount`, `createAccount`, `assign`) fire **before** signing, with no special-casing in the
risk engine. Top-level instructions come from `TransactionMessage.decompile()` (which gives me the
full instruction data and the ALT-resolved keys), and inner instructions come from the simulation's
`innerInstructions`. Programs are named through the same registry, so `programsInvoked`, the program
flag on accounts, and the unknown-program heuristic all behave identically.

### Verified live

I verified this end to end against mainnet. An unsigned transfer to the SOL burn/incinerator address
simulated successfully. It showed SOL deltas of -0.001005 on the payer (including the fee) and +0.001
on the burn address, and the `FLAGGED_ADDRESS` watchlist rule fired **before** signing. Because the
output is the same `ParsedTransaction`, the risk engine, the explanation, and the UI all worked
without a single change.

### Honest limitations of the pre-sign path

I want to be straight about the gaps:

- **The fee is not computed during simulation.** The UI shows it as not-applicable rather than
  guessing.
- **The instruction-type decoder covers SPL Token and System only.** Other programs' instruction
  types are not decoded. The balance, program, and watchlist heuristics still apply to them, but
  type-specific rules (like `setAuthority`) only fire for the two decoded families.
- **It needs a custom RPC.** Public RPC rate-limits `simulateTransaction` with the `accounts`
  option, so a private endpoint is strongly recommended for the pre-sign path.
- **The blockhash is replaced.** Because of that, the real result after signing can differ if
  on-chain state changes before you submit. The explanation says so.

---

## 6. Token metadata enrichment

Raw output is hard to read. A line like `-1250000000 of mint EPjFW...Dt1v` means nothing at a glance.
So `src/lib/metadata.ts` resolves each `mint` to `{ symbol, name, logoURI }` and the UI shows
"USDC" with a logo instead. The module has two layers:

- **A small known-token registry** for the frequent cases, resolved offline with zero network calls:
  SOL (wrapped), USDC, USDT, BONK, JUP, WIF, and JTO.
- **A cached, best-effort Jupiter lookup** for everything else, via
  `https://datapi.jup.ag/v1/assets/search?query=<mint>`. The request has a 3-second abort timeout,
  the result is cached per mint (including misses, so an unknown mint is not re-fetched), and a
  matching entry supplies the symbol, name, and icon.

`enrichTokenMetadata(changes)` runs in `reviewTransaction()` for **both** paths. It dedupes the mints,
fetches them in parallel, writes `symbol` / `name` / `logoURI` back onto each `TokenBalanceChange` in
place, and **never throws**. When a token is unknown or the endpoint is unreachable, the code degrades
gracefully to the raw mint. The token table and the explanation simply fall back to the abbreviated
mint, so enrichment is a pure upgrade with no failure mode that can break a review.

---

## 7. RPC strategy

### Endpoint resolution precedence

`resolveRpcUrl(cluster, rpcUrl?)` in `src/lib/solana.ts` picks the endpoint in this order:

1. **Explicit `rpcUrl`** from the request (for example a Helius/QuickNode URL pasted in the UI). It
   wins if present and non-empty.
2. **`SOLANA_RPC_URL` env var**, used **only for `mainnet-beta`** (deliberately kept off
   devnet/testnet so a mainnet endpoint cannot be accidentally hit for the wrong cluster).
3. **The public cluster default**: `api.mainnet-beta.solana.com`, `api.devnet.solana.com`, or
   `api.testnet.solana.com`.

This lets the PoC run with zero configuration on public RPC while making it trivial to plug in a
private endpoint for reliability. The pre-sign path in particular wants a private endpoint, because
public RPC rate-limits simulate-with-accounts.

### `maxSupportedTransactionVersion` and parsed vs raw

`fetchParsedTransaction()` calls `getParsedTransaction` with
`{ maxSupportedTransactionVersion: 0, commitment: "confirmed" }`. Setting
`maxSupportedTransactionVersion: 0` is required to fetch **versioned (v0) transactions**. Without it,
the RPC throws on any transaction that uses address lookup tables, which covers a large share of
modern DeFi activity. I use the **parsed** variant (not `getTransaction`) on purpose. The RPC decodes
known programs into `{ program, parsed: { type, info } }`, which is exactly what the heuristics and
evidence text rely on. The normalized `version` field on `ParsedTransaction` records `"legacy"` or
the numeric version for display.

### Rate-limit handling & custom RPC

Public RPC endpoints rate-limit aggressively and prune older transactions. The mitigations are
layered:

- A `null` return from `getParsedTransaction` (signature unknown to this RPC because it is too old,
  on the wrong cluster, or not yet confirmed) is mapped by `reviewTransaction()` to a **404** with an
  actionable message.
- Any thrown RPC error (including rate-limit responses) is caught and mapped to a **502**, so the
  user sees a clear "RPC error" rather than an opaque crash. The pre-sign path mirrors this. Lookup,
  pre-state, and simulation RPC failures all surface as 502.
- The **custom `rpcUrl` passthrough** (precedence rule 1) and the `SOLANA_RPC_URL` env var both let
  the operator or user point at a private, higher-limit endpoint that retains historical
  transactions and allows simulate-with-accounts.

---

## 8. The AI seam

### How the explanation is structured

`explainTransaction(tx, risk, options)` in `src/lib/ai.ts` is the single entry point for the
natural-language layer. It resolves the provider from, in order: an explicit `options.provider`, the
`AI_PROVIDER` env var, or the default `"placeholder"`. When the provider is `anthropic` or `openai`
and a matching API key is set, it calls a real LLM. On **any** failure (missing key, network, rate
limit, bad JSON) it falls back to the deterministic `placeholderExplanation(tx, risk)`. The app
always returns a valid `AiExplanation`, and it stays free by default.

The placeholder is a template-based `AiExplanation` assembled entirely from the parsed transaction
and the risk report. It:

- builds a plain-English `summary` (status, cluster, time, signer count, fee, programs, token-change
  count, and the deterministic risk verdict),
- emits `bullets` for status/fee, fee payer, programs, the top SOL movements, and the top token
  balance changes,
- and attaches fixed `caveats`.

The placeholder is also pre-sign aware. For a simulated transaction the framing changes to "This is a
read-only simulation of an unsigned transaction. If signed and sent now, it would..." and it adds a
caveat that the replaced blockhash means the real result can differ if on-chain state changes.

### The grounded prompt

`buildPrompt(tx, risk)` is a pure, exported function. It returns the exact structured context the LLM
receives: the mode (confirmed vs simulation of an unsigned transaction), signature,
cluster/slot/success, fee and fee payer, signers, programs (`name x count`), the full token balance
changes, a compact instruction list (`program` + `type`), and the deterministic risk line (`level`,
`score`, finding IDs). The prompt instructs the model to **only use the facts provided and never
invent addresses, amounts, or intent**, which keeps the LLM grounded in the deterministic extraction.

### Connecting OpenAI / Anthropic

The seam is narrow and already wired. To turn on a real LLM:

1. **Set the provider.** `AI_PROVIDER=openai` or `AI_PROVIDER=anthropic` (or pass `options.provider`),
   and add the corresponding API key as a server-side env var. The key lives only on the Node
   runtime. It is never sent to the browser.
2. **That's it.** `callLlm()` sends the system prompt plus `buildPrompt()` output, parses strict
   minified JSON of the form `{"summary": string, "bullets": string[], "caveats": string[]}`,
   appends a standard caveat, and stamps the model. The Anthropic call caches the static system
   prompt across requests (5-minute TTL). Defaults are `claude-haiku-4-5-20251001`
   (`ANTHROPIC_MODEL`) and `gpt-4o-mini` (`OPENAI_MODEL`), both overridable.
3. **The fallback is automatic.** If no key is configured, or the call fails, or the JSON is
   malformed, the code returns `placeholderExplanation()`. No other module changes, because every
   consumer reads the same `AiExplanation` contract.

### The agentic future

The deterministic core is the grounded base an LLM agent can build on. Because the extraction is
already structured and the risk findings carry stable IDs, a tool-calling agent is a natural next
layer. On top of `buildPrompt()`'s context, such an agent could call read-only tools to enrich its
reasoning:

- **Mint metadata.** Already partly here. The agent could deepen it beyond symbol/name/logo to
  on-chain authorities, supply, and freeze flags.
- **Program IDLs / identity.** Fetch an Anchor IDL or a verified-program registry to name an
  otherwise `UNKNOWN_PROGRAM` and decode its instructions.
- **Prior history.** Pull the fee payer's or a counterparty's recent activity to flag first-time
  interactions or known-bad addresses.

All of these stay **read-only**, and all feed back through the same `AiExplanation` contract. The
deterministic heuristics remain the trustworthy floor. The agent adds context and explanation on top,
and it never replaces the signals with an unverifiable judgment.

---

## 9. Security & limitations

### Read-only by construction

The app only ever reads. It calls `getParsedTransaction`, `getMultipleAccountsInfo`,
`getAddressLookupTable`, and `simulateTransaction` with `sigVerify: false`. There is no keypair, no
signing, and no sending anywhere in the codebase. The pre-sign path's whole point is to inspect a
transaction **without** signing it. The worst-case action is fetching, simulating, and displaying.

### The `rpcUrl` passthrough (SSRF consideration)

The client can supply an arbitrary `rpcUrl`, which the server then fetches. That is a classic
**server-side request forgery (SSRF)** surface if left unguarded. The PoC ships a baseline guard.
`assertSafeRpcUrl()` in `src/lib/solana.ts` requires an `http(s)` URL and **rejects loopback,
private (RFC 1918), link-local `169.254.0.0/16` (cloud metadata), `0.0.0.0`, `localhost`, and
`*.local`/`*.internal` hosts**. `reviewTransaction()` calls it before any fetch and returns a **400**
on violation (verified: `http://169.254.169.254/...` returns `400 "RPC URL host is not allowed."`).
**For production** this should be tightened further to a positive allowlist of known RPC hosts (or
custom-RPC selection moved entirely server-side behind `SOLANA_RPC_URL`), plus DNS-rebinding
protection. The baseline guard closes the obvious vectors. The allowlist is listed as future work.

### Input validation

`isValidSignature()` does cheap base58 structural validation (length 64–90, base58 alphabet) before
any RPC call, and the pre-sign path bounds the decoded transaction size before simulating.
`reviewTransaction()` rejects bad input with a 400 before reaching the network, and routes a request
to the pre-sign path only when `rawTransaction` is present. The route also guards against malformed
JSON bodies (400). Validation is intentionally cheap and fail-fast. The RPC itself is the final
arbiter of whether a signature actually exists.

### No secrets in the client

All RPC and LLM credentials live as **server-side env vars** (`SOLANA_RPC_URL`, `AI_PROVIDER`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and the optional model overrides) and are only read on the
Node runtime. The browser never holds a key. It only POSTs to `/api/review`. The route is pinned to
`runtime = "nodejs"`, so this code never runs at the Edge where env handling differs.

### Error handling

`ReviewError` carries an HTTP `status` so failures map to meaningful codes: 400 (invalid input / bad
JSON), 404 (transaction not found / pruned / wrong cluster), 502 (RPC error). Any unexpected error
becomes a 500 with its message. The pre-sign path raises a `PresignError` with the same status
convention, which `reviewTransaction()` re-wraps. The user always gets an actionable string, not a
stack trace.

### Honest limitations

- **Public RPC** rate-limits and prunes older transactions, and it rate-limits simulate-with-accounts
  outright. Custom RPC (input or env) is the escape hatch.
- **Heuristics are signals, not verdicts.** Every finding says so in its `detail`/`caveats`.
- **The watchlist is best-effort and non-exhaustive.** It is not financial advice. Entries are added
  only with a citable public source.
- **No persistence.** Each review is stateless. Nothing is stored.
- **Pre-sign caveats** apply: no fee in simulation, instruction-type decoding for SPL Token + System
  only, and a replaced blockhash that can diverge from the real post-sign result. See §5.

---

## 10. Testing & extension

### Testing approach

The architecture is built for testability. Every stage except the I/O boundaries is a **pure
function** over the shared types, so it can be unit-tested with fixture data and no network.

`npm test` runs `tests/heuristics.test.ts` (via `tsx`), 24 deterministic checks (10 over the risk engine, 14 over pure helpers),
and they all pass. They prove the behaviors that are hard to verify against live RPC:

- a DEX swap / full position-sell is relabeled `TOKEN_SWAP`, not flagged as a drain,
- a genuine drain (the signer's own tokens leave, no DEX) is HIGH,
- pool/vault accounts (non-signer owners) are ignored,
- wrapped SOL is excluded from the token-outflow rules,
- the watchlist flags a known address,
- and the score no longer saturates on a busy-but-benign swap.

The pre-sign and metadata modules were verified by **live integration against mainnet** rather than
the offline unit suite. Both need a live RPC (and the metadata module hits a live HTTP endpoint), so
they do not fit a deterministic, network-free unit test. The mainnet burn-transfer walkthrough in §5
is the verification record.

Other high-value tests that the pure-function design makes easy:

- **Parser (`parseTransaction`).** Capture a real `getParsedTransaction` response as a JSON fixture
  and assert the normalized output: SOL deltas, the flattened instruction order (top-level + inner
  with correct `parentIndex`), token balance changes, and `programsInvoked` counts.
- **Formatters (`src/lib/format.ts`).** Straightforward pure-function tests for `formatSol`,
  `shortPubkey`, `formatTokenAmount`, and the `isLikelyPubkey` predicate.
- **Prompt builder (`buildPrompt`).** Assert the prompt string contains the expected grounded facts.
  It is exported precisely so it can be tested independently of any provider.
- **API route.** Exercise `POST /api/review` against the validation and error paths: invalid
  signature returns 400, malformed JSON returns 400, unknown signature returns 404, RPC failure
  returns 502.

`package.json` also exposes `npm run typecheck` (`tsc --noEmit`) and `npm run lint`. Under `strict`
TypeScript, the shared contract means a model change surfaces as compile errors across every consumer
before any test runs.

### Extending the heuristics

Adding a rule is a small change in `src/lib/heuristics.ts`:

1. Write a pure `check*(tx: ParsedTransaction)` function returning a `RiskFinding`, `RiskFinding[]`,
   or `null`. Give it a **stable `id`**, a `level`, and a `detail` plus `evidence` so it stays
   explainable.
2. Add it to the `RULES` array.
3. Tune any new constant in the `THRESHOLDS` object.

The aggregator (`score`, overall `level`, dedupe, sorting, `summary`) picks it up automatically. No
other code changes. To change sensitivity, adjust `THRESHOLDS` or the `LEVEL_WEIGHT` map.

### Extending the program registry

To recognize a new program, add an entry to `KNOWN_PROGRAMS` in `src/lib/programs.ts` mapping its
base58 ID to `{ name, category }`. That immediately gives every matching instruction a friendly
`programName`, removes it from the `UNKNOWN_PROGRAM` finding, and lets name-based rules (the Compute
Budget / Memo / BPF-loader checks) match on it. If the program is a swap venue, add it to
`DEX_PROGRAM_IDS` too, so the swap-aware token rules treat its full outflows as swaps rather than
drains. The registry is a small, curated set on purpose, so it stays trustworthy and easy to audit.

### Growing the watchlist

To flag an address or program, add an entry to `src/lib/watchlist.ts` with a `label`, a `category`,
and a **citable** `source`. The matching is already wired, so the list grows without code changes. A
false accusation is harmful, so only add entries backed by a public disclosure.

---

## 11. Roadmap

Two big items shipped. The pre-sign simulation (§5) is done, and the token metadata enrichment (§6)
is done. The real LLM seam is also wired (§8). With those out of the way, the next milestones build
on the grounded base. Estimates are in days, agent-paced.

- **Deepen the LLM guardrails (M2, ~2 days).** The provider calls work. Next is hardening: stricter
  output schemas, prompt-injection resistance against hostile memo/log content, and tighter checks
  that the model never asserts a fact absent from `buildPrompt()`.
- **Richer program/IDL labeling and a CPI tree view (M3, ~3 days).** Resolve Anchor IDLs or a
  verified-program registry to name and decode `UNKNOWN_PROGRAM` calls, and render the instruction
  list as a real parent/child CPI tree instead of the current flattened-with-indent view.
- **Expand heuristics, grow the watchlist, and harden (M4, ~3 days).** More signals (new-mint /
  freeze-authority checks, suspicious approve patterns), a larger watchlist sourced from public
  disclosures, the positive-allowlist SSRF tightening from §9, and broadening the pre-sign
  instruction-type decoder beyond SPL Token + System.

---

## Grant context & contact

I built this for the **Superteam Agentic Engineering Grant** (~200 USDG). The audience is Solana
users and developers who want to **understand and sanity-check transactions before or after signing**.
The value is concrete. Safer signing, because you can simulate an unsigned transaction and see the
risk before you approve it. Faster debugging on confirmed transactions. And an explainable, read-only
base that a real agent can plug into.

Repo: <https://github.com/plutohan/solana-agentic-tx-reviewer> (public).

<!-- CONTACT / LINKS PLACEHOLDER: add demo link and author contact here. -->
