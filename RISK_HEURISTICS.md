# Risk Heuristics

This document is the authoritative specification for the risk engine in the **Solana Agentic Transaction Reviewer**. It is written to match the implementation in [`src/lib/heuristics.ts`](src/lib/heuristics.ts), [`src/lib/programs.ts`](src/lib/programs.ts), and [`src/lib/watchlist.ts`](src/lib/watchlist.ts) exactly. If the code and this document ever diverge, the code wins. They are meant to stay in lock-step, so please update both together.

> **What this tool is.** A lightweight, AI-assisted, **read-only** Solana transaction reviewer. You give it a transaction (a confirmed signature, or an unsigned transaction to simulate). The app normalizes it into a shared data model, runs the deterministic heuristics described here, and produces a human-readable explanation plus a risk report. It is a proof-of-concept I built for the Superteam Agentic Engineering micro-grant. It does **not** sign, send, or mutate anything on-chain. Pre-sign *simulation* of an unsigned transaction is now built and shipped (see [§7](#7-pre-sign-simulation-shipped)).

> **These are the rules that run in production.** This is not a spec for a future engine. The same `assessRisk()` and the same 18 heuristics documented here run in the live deployed app and on the pre-sign (simulated) path. One engine, one rule set, both paths. Nothing in §4 is path-specific.

**Pipeline.** `RPC fetch (or simulate) → parse() → enrich → assessRisk() → explainTransaction() → ReviewResult`

The risk engine is the `assessRisk()` step. Its input is a `ParsedTransaction` (see [`src/lib/types.ts`](src/lib/types.ts)). Its output is a `RiskReport`.

---

## 0. Why this matters: the safety-review step in the agent loop

I built this project **with agents and for agents**, which is the theme of the grant it was made for.

- **Built with agents.** A multi-agent workflow scaffolded, documented, and adversarially reviewed the repository. Agents updated the toolchain (Node 24, Rust 1.96, Agave 4.0.1, Anchor 1.0.2). A research-agent discovery pass confirmed the program IDs in [`src/lib/programs.ts`](src/lib/programs.ts) and de-risked the heuristics in this document. The swap-aware downgrade and the signer-owned restriction below came directly out of that adversarial review. They killed the biggest false positive, a routine Jupiter swap reading `HIGH`.
- **Becoming an agent's reviewer.** Frame this tool as the judgment step between a proposal and a signature. An agent (or human) *proposes* a transaction, the reviewer *judges* it (`parse → heuristics → explanation`), and a human or agent *approves*. The engine's whole purpose is to make the consequential moments of a transaction legible enough that an autonomous or semi-autonomous actor can decide whether to sign. That is the answer to "why does this matter for Solana's agentic future." Agents will sign transactions, and they need a deterministic, auditable, explainable judgment step in between the proposal and the signature.

The risk engine is deterministic on purpose, precisely because it sits in that approval path. See the philosophy below.

---

## 1. Philosophy

The risk engine produces **explainable signals, not a verdict.**

- **Signals, not a score of guilt.** Every finding describes a pattern a careful human reviewer would look for. Drains, authority handovers, delegate approvals, unrecognized programs, flagged addresses. A finding tells you *what is happening* and *why it is worth a second look*. It does **not** assert that a transaction is malicious. Many high-severity findings (a full token-account drain, a large SOL outflow, a `closeAccount`) are perfectly legitimate in the right context. The job of the engine is to make those moments visible so a human (or agent) can judge them.
- **Deterministic.** Given the same `ParsedTransaction`, the engine always returns the same `RiskReport`. There is no randomness, no model temperature, no network call, and no hidden state in the risk path. Each rule is a pure function of the parsed transaction. This makes the report reproducible, testable, and auditable. You can read a rule and know precisely when it fires. The [`npm test`](#5-tests) regression suite locks this behavior down.
- **The LLM never decides risk.** The optional AI layer ([`src/lib/ai.ts`](src/lib/ai.ts)) only *narrates* the transaction and the already-computed findings into plain English. Risk is computed *before* the explanation is generated, so swapping the explanation provider never changes a single score. That layer now genuinely calls **Anthropic or OpenAI** behind a dual-provider seam (`AI_PROVIDER=anthropic|openai`, with `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` or `OPENAI_API_KEY`/`OPENAI_MODEL`). Anthropic requests use **prompt caching** on the system prompt. The **default is a free, deterministic placeholder** (`provider: "placeholder"`), and **any** error (missing key, network failure, rate limit, bad JSON) falls back to that placeholder gracefully. So the "agentic" claim is substantiated the moment a key is configured, and the PoC still runs with **zero keys and zero cost**.
- **Small and curated, on purpose.** The program registry ([`src/lib/programs.ts`](src/lib/programs.ts)), the watchlist ([`src/lib/watchlist.ts`](src/lib/watchlist.ts)), and the rule set are deliberately compact. They are designed to be extended (see [§6](#6-extending-the-engine)), not to be exhaustive on day one.

The guiding principle: **be useful before you sign, and fast to debug after.** A reviewer should be able to glance at the report, understand what moved and what changed control, and decide whether to proceed.

---

## 2. Scoring model

The report has two headline numbers, both derived from the list of findings. I redesigned the scoring path to **de-saturate**. A busy-but-benign transaction (e.g. a routine multi-hop swap) should read `LOW`, while a real, *stacked* drainer should stay `HIGH`.

### Per-level weight

Each finding carries a `level`. Levels map to a numeric weight via `LEVEL_WEIGHT` (unchanged):

| Level    | Weight |
| -------- | -----: |
| `info`   |      0 |
| `low`    |     10 |
| `medium` |     25 |
| `high`   |     45 |

### Step 1: dedup same-id findings (`dedupeFindings`)

Per-occurrence rules can emit the *same* finding `id` several times (e.g. two `FULL_TOKEN_ACCOUNT_DRAIN`s, or two `FLAGGED_ADDRESS` hits). Before scoring, `dedupeFindings()` collapses repeated same-id findings into **one** finding:

- their `evidence` arrays are **merged** (so you still see every concrete fact), and
- the title is tagged with the count, e.g. `Closes a token account (×2)`.

This means a single repeated pattern no longer multiplies its way to a high score on its own.

### Step 2: diminishing returns (`computeScore`)

After dedup, findings are scored with **diminishing returns per level**. Within a level, findings are processed strongest-first, and the `k`-th finding at a given level contributes `weight × 0.5^k` (zero-indexed):

```
contribution(k-th finding at level L) = LEVEL_WEIGHT[L] × 0.5^k     // k = 0, 1, 2, …
score = clamp( round( Σ contributions ),  0,  100 )
```

So at the `high` level the first finding adds `45`, the second `22.5`, the third `11.25`, and so on. The result is rounded and clamped to the inclusive range `0..100`. `info` findings contribute `0` at every position, so they never move the score. They exist to add context, not weight.

> **Worked arithmetic.**
> - One `high` + one `medium`: `45 + 25 = 70`.
> - Two `high` + one `medium`: `45 + 22.5 + 25 = 92.5 → 93`. (Under the old additive model this was `45 + 45 + 25 = 115 → 100`. De-saturation keeps real stacks high without instantly pinning the meter.)
> - One `low` finding (a routine swap relabeled `TOKEN_SWAP`): `10`.

### Overall level

```
level = max( finding.level  for each finding )   // by rank, not by weight
```

The overall `level` is the **single highest finding level present**, ranked `info < low < medium < high` (`LEVEL_RANK`). It is *not* derived from the score. A transaction with one `high` finding is `high` overall even if its score is well under 100. A transaction with twelve `info` findings is still `info` overall with a score of `0`.

### Ordering and summary

- Findings are **sorted by level, highest first**, so the most important signal is always at the top of the report.
- The `summary` string counts findings per level, e.g. `Overall HIGH, 1 high, 1 medium signals.`
- When no rule fires, the report is `score: 0`, `level: "info"`, an empty `findings` array, and the summary `"No notable risk signals were detected by the deterministic heuristics."`

The full `RiskReport` shape (from [`src/lib/types.ts`](src/lib/types.ts)):

```ts
interface RiskReport {
  score: number;        // 0–100, higher = riskier
  level: RiskLevel;     // highest individual finding level
  findings: RiskFinding[];
  summary: string;
}

interface RiskFinding {
  id: string;           // stable rule id, e.g. "FULL_TOKEN_ACCOUNT_DRAIN"
  title: string;
  level: RiskLevel;     // "info" | "low" | "medium" | "high"
  detail: string;
  evidence?: string[];  // human-readable supporting facts
}
```

---

## 3. Thresholds and constants

All tunable cut-offs live in the `THRESHOLDS` object in [`src/lib/heuristics.ts`](src/lib/heuristics.ts). Changing a value here changes when the corresponding rule fires. No other code needs to move.

| Threshold              | Value      | Unit                    | Used by                                    |
| ---------------------- | ---------- | ----------------------- | ------------------------------------------ |
| `largeSolOutflow`      | `1`        | SOL                     | `LARGE_SOL_OUTFLOW` (medium trigger)       |
| `veryLargeSolOutflow`  | `10`       | SOL                     | `LARGE_SOL_OUTFLOW` (high escalation)      |
| `manyWritableAccounts` | `12`       | count of accounts       | `MANY_WRITABLE_ACCOUNTS`                   |
| `highFeeSol`           | `0.01`     | SOL                     | `HIGH_FEE`                                 |
| `largeTokenOutflowPct` | `0.5`      | fraction of pre-balance | `LARGE_TOKEN_OUTFLOW` (entry threshold)    |

Related constants in the same family (not in `THRESHOLDS`):

- The `LARGE_TOKEN_OUTFLOW` rule escalates from `low` to `medium` at a hard-coded **90% (`0.9`)** of the prior balance.
- `DUST_LAMPORTS = 1_000_000` (**0.001 SOL**). A SOL inflow at or below this is treated as "dust" and does **not** count as value-back for the swap-aware downgrade (§4.5). A token inflow must exceed **1 base unit** to count.
- The set of programs treated as token programs for instruction-level rules is `TOKEN_PROGRAMS = { "spl-token", "spl-token-2022" }` (matched against the parsed `program` label, not the program ID).
- `WSOL_MINT = "So11111111111111111111111111111111111111112"` (from [`src/lib/programs.ts`](src/lib/programs.ts)). Wrapped SOL, **excluded** from the token-movement rules (§4.4–§4.6).
- `DEX_PROGRAM_IDS` / `isDexProgram()` (from [`src/lib/programs.ts`](src/lib/programs.ts)). The set of swap venues/aggregators that, when present, enable the swap-aware downgrade. It currently contains **Jupiter v6 & v4, Raydium AMM v4 / CLMM / CPMM, Orca Whirlpools, Meteora DLMM & DAMM v2, Phoenix, Lifinity v2, PumpSwap AMM, and the pump.fun bonding curve.**

---

## 4. The rules

There are **18 heuristics** (rule IDs), evaluated in the order the rule functions appear in the `RULES` array. A rule function returns one finding, an array of findings, or `null`. The two newest IDs, `TOKEN_SWAP` (§4.5) and `FLAGGED_ADDRESS` (§4.18), were added in the precision-tuning round.

| #  | ID | Level(s) | Trigger (short) |
| -- | -- | -------- | --------------- |
| 1  | `TX_FAILED` | `info` | `meta.err != null` (`tx.success === false`) |
| 2  | `FLAGGED_ADDRESS` | `medium` (burn) / `high` (other) | an account or program ID matches the curated watchlist |
| 3  | `UNKNOWN_PROGRAM` | `medium` | invokes ≥1 program not in the registry |
| 4  | `LARGE_SOL_OUTFLOW` | `medium` (≥1 SOL) / `high` (≥10 SOL) | fee payer net SOL decrease past threshold |
| 5  | `TOKEN_SWAP` | `low` | signer's would-be drain/outflow, but value came back via a known DEX |
| 6  | `FULL_TOKEN_ACCOUNT_DRAIN` | `high` | signer-owned token account `pre > 0` and `post == 0` |
| 7  | `LARGE_TOKEN_OUTFLOW` | `low` (≥50%) / `medium` (≥90%) | signer-owned partial token decrease as a % of prior balance |
| 8  | `SET_AUTHORITY` | `high` | spl-token `setAuthority` |
| 9  | `ACCOUNT_REASSIGN` | `medium` | system `assign` |
| 10 | `TOKEN_DELEGATE_APPROVE` | `medium` | spl-token `approve` / `approveChecked` |
| 11 | `CLOSE_TOKEN_ACCOUNT` | `medium` | spl-token `closeAccount` |
| 12 | `PROGRAM_DEPLOY_OR_UPGRADE` | `medium` | BPF Upgradeable Loader involved |
| 13 | `MANY_WRITABLE_ACCOUNTS` | `low` | writable account count ≥ 12 |
| 14 | `HIGH_FEE` | `low` | fee > 0.01 SOL |
| 15 | `NEW_ACCOUNT_CREATION` | `info` | system `createAccount` / `createAccountWithSeed` / `allocate` |
| 16 | `MULTIPLE_SIGNERS` | `info` | more than 1 signer |
| 17 | `COMPUTE_BUDGET_SET` | `info` | Compute Budget program used |
| 18 | `MEMO_PRESENT` | `info` | Memo program used |

> **Note on counting and the three token-movement IDs.** `TOKEN_SWAP`, `FULL_TOKEN_ACCOUNT_DRAIN`, and `LARGE_TOKEN_OUTFLOW` are all emitted by a single rule function, `checkTokenMovements`. They are **mutually exclusive per account** (see §4.5–§4.7). Rules that emit **at most one** finding per transaction: `TX_FAILED`, `UNKNOWN_PROGRAM`, `LARGE_SOL_OUTFLOW`, `PROGRAM_DEPLOY_OR_UPGRADE`, `MANY_WRITABLE_ACCOUNTS`, `HIGH_FEE`, `NEW_ACCOUNT_CREATION`, `MULTIPLE_SIGNERS`, `COMPUTE_BUDGET_SET`, `MEMO_PRESENT`. **Per-occurrence** rules (can emit several findings, later deduped by §2): `FLAGGED_ADDRESS`, the three token-movement IDs, `SET_AUTHORITY`, `ACCOUNT_REASSIGN`, `TOKEN_DELEGATE_APPROVE`, `CLOSE_TOKEN_ACCOUNT`.

> **Same rules run on the pre-sign (simulated) path.** Everything in §4 is computed from a `ParsedTransaction`, and the pre-sign path (§7) emits the exact same `ParsedTransaction` shape with `simulated: true`. So every rule here fires identically on a simulated transaction, with no separate risk logic. Two things are worth knowing about the simulated inputs. First, the token deltas come from **simulated** post-state (a diff of pre-state against the simulated accounts the RPC returns), not from confirmed `pre/postTokenBalances`. Second, the `program`/`parsedType` fields that the instruction-level rules (§4.8–§4.11) key off are recovered for the simulated path by a small **SPL Token / System discriminator decoder** that maps raw instruction data back to the same type strings the confirmed (jsonParsed) path produces. Instructions from other programs degrade gracefully: they keep program-level signals plus the balance and watchlist rules (`UNKNOWN_PROGRAM`, `LARGE_SOL_OUTFLOW`, the token-movement IDs, `FLAGGED_ADDRESS`, and so on), but their instruction *type* is not decoded, so a `parsedType`-dependent rule will not fire on them.

---

### 4.1 `TX_FAILED`: transaction failed on-chain

- **Level:** `info`
- **Trigger:** `tx.success === false` (i.e. `meta.err != null` in the raw RPC response).
- **Rationale:** A failed transaction's instructions had **no lasting effect** beyond the fee paid. Failure is not itself dangerous, but it can be a tell. A misconfigured client, a slippage/deadline failure, or a hostile interaction that reverted. Surfacing it explains *why nothing moved* and prevents a reviewer from mistaking a no-op for a clean run.
- **Evidence:** `Error: <JSON of tx.err>`.
- **Example:** A swap that exceeded its slippage tolerance reverts. The report shows `TX_FAILED` and the underlying error object.
- **False positive / negative:** Not applicable in the risk sense. This is a factual flag. It is `info` precisely because "failed" is not "risky." Note that a failed transaction still pays a fee, so a `HIGH_FEE` finding can legitimately co-occur.

---

### 4.2 `FLAGGED_ADDRESS`: address on the curated watchlist

- **Level:** `medium` when the matched entry's `category` is `"burn"`. **`high`** for every other category (`drainer`, `scam`, `phishing`, `sanctioned`).
- **Trigger:** Any account pubkey in `tx.accounts` *or* any program ID in `tx.programsInvoked` matches an entry in the watchlist ([`src/lib/watchlist.ts`](src/lib/watchlist.ts)) via `lookupWatch(address)`. Candidate addresses are de-duplicated before lookup, so a single flagged address is checked once. Distinct flagged addresses each emit their own finding (then deduped by §2 if they share the `FLAGGED_ADDRESS` id).
- **Rationale:** Some addresses are worth flagging on sight. A known drainer wallet, a sanctioned address, or the SOL burn/incinerator (funds sent there are destroyed irreversibly). The watchlist makes that knowledge a first-class, evidence-backed signal.
- **The watchlist itself is best-effort and honest by construction.** [`src/lib/watchlist.ts`](src/lib/watchlist.ts) is **BEST-EFFORT, NON-EXHAUSTIVE, and not financial advice.** It is seeded honestly with exactly one entry, the well-known SOL **burn/incinerator** address `1nc1nerator1111…1111` (category `burn`, hence `medium`). `FLAGGED_ADDRESSES` is otherwise meant to grow only with citable public sources (each entry carries a `source` field), and `FLAGGED_PROGRAMS` is **intentionally empty by default** to avoid falsely accusing a legitimate program. The matching mechanism already covers both lists, so the watchlist can grow with no code changes.
- **Evidence:** `<shortPubkey(addr)>, <category>: <label> (source: <source>)`.
- **Example:** A transaction that sends a token balance to `1nc1nerator1111…1111` produces `FLAGGED_ADDRESS` at `medium` with the burn label and source.
- **False positive / negative:**
  - **False positive:** Burning tokens to the incinerator is sometimes entirely intentional (deflationary mechanics, closing a position by burning). That is why `burn` is only `medium`. It is "be sure you meant to destroy this," not "you are being attacked."
  - **False negative:** The list is deliberately tiny and curated. The vast majority of malicious addresses are **not** on it. A clean `FLAGGED_ADDRESS` result means "no *known-listed* address was involved," never "safe."

---

### 4.3 `UNKNOWN_PROGRAM`: interacts with unrecognized program(s)

- **Level:** `medium`
- **Trigger:** At least one entry in `tx.programsInvoked` has a `programId` that is **not** present in `KNOWN_PROGRAMS` (`isKnownProgram(programId) === false`). All such programs are reported in a single finding.
- **Rationale:** The registry is a small, curated allow-list of well-known programs (System, SPL Token, the major DEXs and aggregators, pump.fun, Metaplex, Jito Tip, etc.). A program outside it is simply *unrecognized by this tool*. Worth a glance, because unknown code is where novel risk hides.
- **Evidence:** One line per unknown program: `<programId> (<n> instruction(s))`.
- **Example:** A legitimate but niche DeFi protocol not yet in the registry triggers a single `UNKNOWN_PROGRAM` finding listing its program ID and invocation count.
- **False positive / negative:**
  - **False positive (common):** Most unknown programs are benign. The registry, while expanded in this round, is still curated, so any real-world app outside it will trip this. Treat it as "verify you trust this program," not "this is malicious."
  - **False negative:** A *known* program can still be used maliciously (e.g. a malicious `approve` through the genuine SPL Token program). This rule says nothing about how a known program is used. The instruction-level rules (§4.8–§4.11) cover that.
  - **Mitigation:** Add trustworthy programs to `KNOWN_PROGRAMS` ([§6](#6-extending-the-engine)) to reduce noise.

---

### 4.4 `LARGE_SOL_OUTFLOW`: signing wallet sends a large amount of SOL

- **Level:** `medium` when outflow ≥ `largeSolOutflow` (1 SOL). Escalates to `high` when outflow ≥ `veryLargeSolOutflow` (10 SOL).
- **Trigger:** The fee payer's **net** SOL change is negative and the magnitude exceeds the threshold. Concretely: `outflow = -feePayer.solChangeSol`. The rule fires when `outflow > 1`, and is `high` when `outflow >= 10`. `solChangeSol` is post-balance minus pre-balance, so this captures the *net* effect including the fee.
- **Rationale:** A large net decrease in the signer's SOL is the single most consequential thing a transaction can do to a wallet's native balance. Large outflows are equally common in legitimate transfers and in drains, so the rule flags the *magnitude*, not the intent. (This is also where **wrapped SOL** is accounted for. WSOL is excluded from the token rules precisely because native-SOL movement is the right place to read it.)
- **Evidence:** `Net change for <shortPubkey(feePayer)>: -<amount> SOL (includes <fee> SOL fee)`.
- **Example:** A wallet sends 12 SOL to an exchange deposit address. Net change ≈ -12 SOL → `high`. A 2 SOL purchase → `medium`.
- **False positive / negative:**
  - **False positive:** Intended large transfers (paying an invoice, funding a new wallet, an NFT mint) look identical to a drain by this metric. That is by design. The reviewer confirms the destination.
  - **False negative:** Because this measures the *fee payer's net* change, a drain that empties a **token** account (no SOL movement) or sends SOL out of a **non-signer** account will not trip this rule. Those are caught by the token rules (§4.6–§4.7) instead. Also, a transaction where the wallet both sends and receives SOL nets out and may fall below the threshold.

---

### Token movements (§4.5–§4.7): three precision changes to `checkTokenMovements`

Rules `TOKEN_SWAP`, `FULL_TOKEN_ACCOUNT_DRAIN`, and `LARGE_TOKEN_OUTFLOW` all come out of one function, `checkTokenMovements(tx)`, which walks `tx.tokenBalanceChanges`. This round tightened it with **three precision filters** that, together, eliminated the largest source of false positives (a routine swap previously reading `HIGH` "fully drained" off a pool account):

1. **Wrapped-SOL exclusion.** Any change whose `mint === WSOL_MINT` is skipped outright (`continue`). Wrapped SOL is transient. It is wrapped and unwrapped within swaps, and the native-SOL rules (§4.4) already cover its real economic effect. Without this, every WSOL swap leg looked like a token drain.
2. **Signer-owned-only restriction.** A change is considered **only** when it has a known `owner` *and that owner is one of `tx.signers`* (`if (!c.owner || !signers.has(c.owner)) continue;`). **Pool and vault accounts, owned by program PDAs and not by the signer, routinely zero out during swaps and are now ignored.** This is the fix that killed the headline false positive. A routine Jupiter/PumpSwap trade no longer reads a pool's `pre > 0 → post 0` as a "full drain." A drain that matters is one that empties *your* account.
3. **Swap-aware downgrade.** Before emitting a high-risk drain/outflow for a qualifying signer-owned account, the rule asks: *did the same owner receive value back through a known DEX in this same transaction?* If so, it **relabels** the finding as a low-severity `TOKEN_SWAP` instead (see §4.5 for the exact gating). This is a *relabel, not a clear*. The movement is still surfaced, just at the right severity.

Helper context (`buildSwapContext(tx)`) computes two things once per transaction:
- `dexPresent`, `true` if any invoked program satisfies `isDexProgram()`.
- `inflowOwners`, the set of owners who received **non-dust value back**: a token inflow of **> 1 base unit** (any mint, including WSOL) *or* a net SOL increase of **> `DUST_LAMPORTS` (0.001 SOL)**.

---

### 4.5 `TOKEN_SWAP`: token swapped via a DEX (defensive relabel)

- **Level:** `low`
- **Trigger:** Inside `checkTokenMovements`, for a **signer-owned, non-WSOL** account that *would otherwise* be a full drain or a large outflow, the rule emits `TOKEN_SWAP` instead **when both** of these hold:
  1. a known DEX/aggregator is present in the transaction (`dexPresent === true`, via `isDexProgram()`), **and**
  2. the **same owner** appears in `inflowOwners`. That exact signer received non-dust value back (a token inflow `> 1` base unit, or a net SOL inflow `> 0.001 SOL`) in the same transaction.

  When it fires, the account's drain/outflow finding is replaced by this single `low` finding and evaluation moves on (`continue`).
- **Rationale:** Selling an entire token position through a DEX produces the *exact same* on-chain shape as a drain. A signer-owned token account goes to zero. The distinguishing fact is **reciprocity**. In a swap, value comes *back* to the same wallet (the other side of the trade). In a drain, it does not. When both the DEX context and the same-owner inflow are present, the honest label is "swap / position exit," not "drain."
- **Defensive gating, why it fails safe.** The relabel is deliberately conservative so an attacker cannot use it to launder a real drain into a `low`:
  - **Same signer must receive value back.** A different wallet receiving the proceeds does not qualify the victim's account.
  - **Dust guard.** A token inflow must exceed **1 base unit**, and a SOL inflow must exceed **0.001 SOL** (`DUST_LAMPORTS`). A drainer that sprinkles a token of dust "inflow" to fake reciprocity fails this guard, so the drain finding stands.
  - **Undefined / non-signer owner fails safe.** If `c.owner` is missing, or the owner is not a signer, the change never reaches the relabel branch at all (it was filtered out by the signer-owned restriction). A would-be qualifying account with an undefined owner can never be in `inflowOwners`. Anything ambiguous falls through to the **higher-risk** finding (`FULL_TOKEN_ACCOUNT_DRAIN` / `LARGE_TOKEN_OUTFLOW`), never the gentler one.
  - **No DEX, no downgrade.** Tokens leaving a signer's account with *no* known DEX in the transaction are never relabeled. That is precisely the drain shape.
- **Evidence:** `<owner> swapped <amount> of mint <mint> via a known DEX`.
- **Example:** A user sells their entire `MEME` balance on PumpSwap and receives ~1.2 SOL back → one `low` `TOKEN_SWAP` finding, overall level `low`, score well under `25`. No `FULL_TOKEN_ACCOUNT_DRAIN`.
- **False positive / negative:**
  - **False positive:** Minimal by design. The gate requires both a known DEX *and* same-owner reciprocity. It is still a `low` nudge ("verify the amounts and counterparty"), not a clean bill of health.
  - **False negative:** A genuine swap through a DEX that this engine does not yet recognize (not in `DEX_PROGRAM_IDS`) will **not** be relabeled and will surface as the higher-risk drain/outflow. A deliberately safe failure mode. Add the venue to `DEX_PROGRAM_IDS` ([§6](#6-extending-the-engine)) to teach the engine about it.

---

### 4.6 `FULL_TOKEN_ACCOUNT_DRAIN`: token account fully drained

- **Level:** `high`
- **Trigger:** For a **signer-owned, non-WSOL** entry in `tx.tokenBalanceChanges`, `uiPreAmount > 0` **and** `uiPostAmount === 0`, **and** the swap-aware downgrade (§4.5) did not apply. One finding per drained account (deduped if several).
- **Rationale:** A *signer-owned* token account going from a positive balance to exactly zero, with **no** reciprocal value back through a DEX, is the signature pattern of a wallet drain. It is high-impact and unambiguous about *what happened* (everything left), if not *why*.
- **Evidence:** `<owner> sent its entire balance of mint <mint>`.
- **Example:** A victim's USDC token account with 1,000 USDC pre-balance reads 0 post-balance, with no DEX present and no SOL/token coming back → one `high` finding.
- **False positive / negative:**
  - **False positive:** Legitimate full exits *outside* a recognized DEX still look identical (e.g. moving a stablecoin balance to another self-owned wallet). High severity is intentional so the reviewer always sees it. A full exit *through* a recognized DEX is the `TOKEN_SWAP` case instead.
  - **False negative:** Pool/vault accounts are intentionally ignored (they are not signer-owned). A drain that leaves a dust remainder (post-balance `> 0`) escapes this exact rule, but a large-enough remainder-leaving outflow is caught by `LARGE_TOKEN_OUTFLOW` (§4.7). The rule depends on `pre/postTokenBalances` being present in the RPC response.

---

### 4.7 `LARGE_TOKEN_OUTFLOW`: large partial token outflow

- **Level:** `medium` when the outflow is ≥ 90% of the prior balance. Otherwise `low` (down to the 50% entry threshold).
- **Trigger:** For a **signer-owned, non-WSOL** token balance change with `delta < 0` and `uiPreAmount > 0`, compute `pct = |delta| / uiPreAmount`. The rule fires when `pct >= largeTokenOutflowPct` (0.5) **and** it is not a full drain **and** the swap-aware downgrade (§4.5) did not apply. Within that, `level = pct >= 0.9 ? "medium" : "low"`. One finding per qualifying account.
- **Rationale:** A signer-owned account shedding a large *fraction* of its balance is a softer version of a full drain. The percentage framing means a 60%-of-balance move is flagged whether the balance is 10 tokens or 10 million. The *proportion* is what matters to the holder.
- **Evidence:** `<owner> sent <amount> of mint <mint> (<pct>% of its prior balance)`.
- **Example:** A signer-owned account holding 1,000 of a mint sends 950 (95%) with no reciprocal DEX inflow → `medium`. Sending 600 (60%) → `low`.
- **False positive / negative:**
  - **Relationship to §4.5/§4.6:** The three branches are mutually exclusive per account. `checkTokenMovements` evaluates them in order: swap-aware relabel (`TOKEN_SWAP`) first, then full drain (`FULL_TOKEN_ACCOUNT_DRAIN`), then this partial-outflow branch. So a swap is never a drain, and a 100% outflow is reported as a `high` drain, never a `medium` outflow.
  - **False positive:** Rebalancing, partial sells *outside* a recognized DEX, and routing a large trade all produce large legitimate outflows.
  - **False negative:** Outflows below 50% of the prior balance produce **no** finding here. Pool/vault (non-signer) and WSOL changes are excluded entirely. An account that starts at zero (`uiPreAmount === 0`) is never flagged.

---

### 4.8 `SET_AUTHORITY`: changes a token account / mint authority

- **Level:** `high`
- **Trigger:** A flattened instruction whose parsed `program` is a token program (`spl-token` / `spl-token-2022`) and whose `parsedType === "setAuthority"`. One finding per occurrence.
- **Rationale:** `SetAuthority` transfers *control* of a token account or mint (owner, close, mint, or freeze authority). Handing over authority is among the highest-impact actions in SPL Token and is a common step in account takeovers. Control can outlast a single transaction.
- **Evidence:** `Sets <authorityType> to <shortPubkey(newAuthority)>` (falls back to `"authority"` / `"a new authority"` when the parsed `info` is absent).
- **Example:** An instruction sets the `AccountOwner` authority of a token account to an unfamiliar address → `high`.
- **False positive / negative:**
  - **False positive:** Legitimate during mint setup, revoking a mint authority (setting it to none), or migrating account ownership in a controlled flow.
  - **False negative:** Requires a *parsed* instruction (a jsonParsed RPC response, or the discriminator decoder on the pre-sign path). If a program performs an equivalent control change through its own (unparsed) instruction layout, the `parsedType` will not be `setAuthority` and this rule will not fire. Inner/CPI instructions are included in the flattened list, so CPI-driven `setAuthority` calls are covered when parsed.

---

### 4.9 `ACCOUNT_REASSIGN`: reassigns account ownership (System Assign)

- **Level:** `medium`
- **Trigger:** An instruction with parsed `program === "system"` and `parsedType === "assign"`. One finding per occurrence.
- **Rationale:** A System `Assign` changes which *program* owns an account. Reassigning ownership hands the account's future behavior to a different program. Meaningful for account-level control and worth confirming against the operation you intended.
- **Evidence:** `Assigns to owner <shortPubkey(owner)>`.
- **Example:** A setup flow assigns a freshly created account to a custom program → `medium`.
- **False positive / negative:**
  - **False positive:** Common and benign during account initialization (create-then-assign patterns). Medium severity reflects "verify this is expected," not "this is wrong."
  - **False negative:** Only matches the parsed System `assign` type. Ownership transfers performed by other means are not detected here.

---

### 4.10 `TOKEN_DELEGATE_APPROVE`: approves a token delegate

- **Level:** `medium`
- **Trigger:** A token-program instruction with `parsedType === "approve"` **or** `parsedType === "approveChecked"`. One finding per occurrence.
- **Rationale:** `Approve` grants another address (a delegate) the standing right to move tokens out of the account *later*, without a fresh signature. Malicious dApps abuse delegate approvals to set up a drain they execute after you have moved on. This is one of the most important "looks harmless now, dangerous later" patterns in SPL Token.
- **Evidence:** `Delegate <shortPubkey(delegate)> approved for <amount>` (amount is read from `info.amount`, falling back to `info.tokenAmount.amount`, then to `"an amount"`).
- **Example:** A "connect and approve" flow grants an unfamiliar delegate approval for a very large amount → `medium`.
- **False positive / negative:**
  - **False positive:** Many legitimate protocols (lending, escrow, some DEX flows) use delegation as a normal mechanic.
  - **False negative:** Only `approve` / `approveChecked` parsed types match. The rule flags the *grant*. It cannot know whether the delegate will ever act on it. A reviewer should weigh the delegate's identity and the approved amount.

---

### 4.11 `CLOSE_TOKEN_ACCOUNT`: closes a token account

- **Level:** `medium`
- **Trigger:** A token-program instruction with `parsedType === "closeAccount"`. One finding per occurrence.
- **Rationale:** `CloseAccount` reclaims an account's rent lamports to a destination and removes the account. Benign as routine cleanup, but it is also the *final step of a drain*. Empty the tokens, then close the account and sweep the rent. Surfacing the destination lets the reviewer check where the reclaimed lamports go.
- **Evidence:** `Closes <shortPubkey(account)> → <shortPubkey(destination)>`.
- **Example:** After a token balance is moved out, the empty account is closed with rent sent to an unfamiliar destination → `medium` (and likely alongside §4.6).
- **False positive / negative:**
  - **False positive:** Wallets routinely close empty associated token accounts to recover rent. Entirely benign. (Note: a swap that ends by closing the temporary WSOL account is also routine.)
  - **False negative:** Only the parsed `closeAccount` type matches. A close performed via an unparsed instruction layout would be missed.

---

### 4.12 `PROGRAM_DEPLOY_OR_UPGRADE`: interacts with the upgradeable loader

- **Level:** `medium`
- **Trigger:** Any entry in `tx.programsInvoked` whose resolved `name` is `"BPF Loader (Upgradeable)"` (program ID `BPFLoaderUpgradeab1e11111111111111111111111`). At most one finding.
- **Rationale:** Touching the BPF Upgradeable Loader means a program deploy, an upgrade, or an upgrade-authority change. High-impact developer operations that change *code* on-chain. For a developer reviewing their own deploy this is expected. Encountering it unexpectedly is a strong reason to verify the target program.
- **Evidence:** None beyond the title (no `evidence` array is attached).
- **Example:** A program upgrade transaction lists the upgradeable loader among its invoked programs → `medium`.
- **False positive / negative:**
  - **False positive:** Routine and expected for developers shipping or upgrading programs.
  - **False negative:** This matches on the resolved program *name*, so it depends on the program ID being mapped to that exact name in the registry. The non-upgradeable `BPF Loader 2` is a separate registry entry and does **not** trigger this rule.

---

### 4.13 `MANY_WRITABLE_ACCOUNTS`: large writable surface

- **Level:** `low`
- **Trigger:** `tx.writableAccounts.length >= manyWritableAccounts` (≥ 12). At most one finding.
- **Rationale:** The number of *writable* accounts is the breadth of state a transaction can modify. A large writable set is normal for complex DeFi routes (multi-hop swaps, aggregators), but a broad write surface is worth a glance, especially on an otherwise simple-looking transaction.
- **Evidence:** None beyond the title (the count appears in the title itself, e.g. `14 writable accounts`).
- **Example:** A Jupiter multi-hop swap touching 15 writable accounts → `low`.
- **False positive / negative:**
  - **False positive (common):** Aggregated swaps and complex DeFi legitimately exceed 12 writable accounts all the time. This is a low-severity nudge, not an alarm. Thanks to diminishing returns (§2), it no longer pushes a busy swap's score up much.
  - **False negative:** A damaging transaction can touch very few writable accounts (e.g. a single `setAuthority`). Account *count* is a coarse signal. The specific instruction rules carry the weight.

---

### 4.14 `HIGH_FEE`: elevated fee

- **Level:** `low`
- **Trigger:** `tx.feeSol > highFeeSol` (> 0.01 SOL).
- **Rationale:** The base fee on Solana is tiny. A fee above this threshold almost always reflects a **priority fee**. Not risky on its own, but notable. Unusually high fees can indicate congestion bidding or, occasionally, a misconfigured client.
- **Evidence:** None beyond the title (the fee appears in the title, e.g. `Elevated fee (0.0150 SOL)`).
- **Example:** A transaction submitted during congestion with a large priority fee → `low`.
- **Note for the pre-sign path:** the fee is not computed during simulation (it shows as not-applicable), so this rule does not fire on a simulated transaction (§7).
- **False positive / negative:**
  - **False positive:** Entirely normal during network congestion or for latency-sensitive trades.
  - **False negative:** A perfectly normal fee says nothing about the transaction's *effects*. A cheap transaction can still be a drain.

---

### 4.15 `NEW_ACCOUNT_CREATION`: creates new accounts

- **Level:** `info`
- **Trigger:** One or more instructions with parsed `program === "system"` and `parsedType` in `{ createAccount, createAccountWithSeed, allocate }`. At most one finding (the count is aggregated).
- **Rationale:** Creating accounts is routine. New token accounts, program state, PDAs. It is surfaced as context (especially common on first-time interactions with a protocol), and contributes `0` to the score.
- **Evidence:** None beyond the title (`Creates N new account(s)`).
- **Example:** A first swap on a new token creates the associated token account → `info`.
- **False positive / negative:** Informational only. Account creation is so common that it carries no weight. It exists to explain *why* rent was spent and new accounts appeared.

---

### 4.16 `MULTIPLE_SIGNERS`: more than one signer

- **Level:** `info`
- **Trigger:** `tx.signers.length > 1`.
- **Rationale:** Multiple signers are expected in multisig or co-signed flows. Surfacing it is useful because an *unexpected* co-signer is worth checking. On its own it is neutral.
- **Evidence:** None beyond the title (`N signers`).
- **Example:** A multisig-approved transfer with two signers → `info`.
- **False positive / negative:** Informational. The rule cannot tell an expected co-signer from a suspicious one. That judgment is left to the reviewer.

---

### 4.17 `COMPUTE_BUDGET_SET`: sets a compute budget

- **Level:** `info`
- **Trigger:** Any entry in `tx.programsInvoked` with resolved `name === "Compute Budget"` (program ID `ComputeBudget111111111111111111111111111111`).
- **Rationale:** Compute Budget instructions set compute-unit limits and prices (the mechanism behind priority fees). They are routine for essentially all modern transactions and are surfaced purely as context.
- **Evidence:** None beyond the title.
- **Example:** Nearly any current wallet transaction includes a compute-budget instruction → `info`.
- **False positive / negative:** Informational and near-ubiquitous. It pairs naturally with `HIGH_FEE` to explain an elevated fee.

---

### 4.18 `MEMO_PRESENT`: attaches a memo

- **Level:** `info`
- **Trigger:** Any entry in `tx.programsInvoked` whose resolved `name` is `"Memo"` or `"Memo (v1)"` (program IDs `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` and `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`).
- **Rationale:** A Memo instruction attaches a note to the transaction. It is commonly used by exchanges and CEX deposit flows, so its presence is a helpful hint about *who* the counterparty might be.
- **Evidence:** None beyond the title.
- **Example:** A CEX deposit that requires a memo tag → `info`.
- **False positive / negative:** Informational. A memo's *content* is not parsed or judged by this rule.

---

## 5. Tests

A deterministic regression suite ([`tests/heuristics.test.ts`](tests/heuristics.test.ts), run with `npm test` via `tsx`) locks down exactly the behaviors that are hard to verify against live RPC. It runs **10 assertions** across these scenarios, and all pass:

1. **Sell via a DEX is a swap, not a drain.** A full position-sell through PumpSwap with SOL coming back asserts `TOKEN_SWAP` is present, `FULL_TOKEN_ACCOUNT_DRAIN` is **absent**, the overall level is **not** `high`, and the score is `< 25`.
2. **A genuine drain stays HIGH.** A signer's token account emptied with **no** DEX and **no** value back asserts `FULL_TOKEN_ACCOUNT_DRAIN` is present, the level is `high`, and the score is `>= 45`.
3. **Pool/vault noise is filtered.** A non-signer (`POOLVAULTPDA`) account zeroing out during a swap produces **no** token-movement finding.
4. **Wrapped SOL is excluded.** A signer's WSOL balance going to zero produces no `FULL_TOKEN_ACCOUNT_DRAIN` / `LARGE_TOKEN_OUTFLOW`.
5. **The watchlist fires.** A transaction touching the burn/incinerator address produces `FLAGGED_ADDRESS`.

These tests are the proof that de-saturation, the signer-owned restriction, WSOL exclusion, the swap-aware downgrade, and the watchlist all behave as documented here. `tsx` is a dev dependency, and the project is a git repository (baseline + enhancement commits).

The pre-sign simulation (§7) and token metadata enrichment need a live RPC and a network call, so they are **not** in the offline unit suite. I verified them by live integration against mainnet instead. The deterministic heuristics they feed are exactly the ones the `npm test` suite already covers, since both paths emit the same `ParsedTransaction`.

---

## 6. How to read a report

1. **Start at the overall `level` and `summary`.** The level is the highest single finding present. The summary counts findings by level. This is your one-line gut check.
2. **Glance at the `score` for intensity.** With de-saturation (§2), a high level with a low-ish score means "one serious thing." A high score now genuinely means "several serious things stacked." A routine swap reads `low`. A stacked drainer reads `high`.
3. **Read findings top-down.** They are sorted highest-severity first, after same-id dedup (so a repeated pattern shows as one finding tagged `×N` with all evidence merged). For each, read the `title`, the `detail` (why it matters), and the `evidence` (the concrete facts: which account, which mint, which amount, which destination, which source).
4. **Decide.** The engine never decides for you. Its job is to make the consequential moments (what moved, what changed control) impossible to miss. In the agent loop, this is the step where the proposal is judged before approval.

> **Remember:** these are signals, not verdicts. A `high` overall level frequently describes a perfectly legitimate transaction (a big transfer, a full position exit outside a recognized DEX). The value is that you *saw it and confirmed it* before signing, or understood it quickly while debugging.

### Worked example A: a hypothetical wallet drain

A victim, tricked into signing, does the following in one transaction. **No recognized DEX is involved:**

- A USDC token account they own, holding **1,000 USDC**, goes to **0** (`pre = 1000`, `post = 0`).
- The signing wallet's **native SOL** drops by **~3 SOL** net (sent to an attacker address).
- The now-empty USDC token account is **closed**, with the reclaimed rent sent to the attacker.
- The transaction touches an **unrecognized program** that orchestrated the drain.

The engine produces roughly:

| Finding | Level | Diminishing-returns contribution | Why it fired |
| ------- | ----- | -------------------------------: | ------------ |
| `FULL_TOKEN_ACCOUNT_DRAIN` | `high` | `45` (1st high) | signer-owned USDC account went 1,000 → 0, no DEX/value back |
| `LARGE_SOL_OUTFLOW` | `medium` | `25` (1st medium) | fee payer net −3 SOL (≥ 1, < 10 SOL) |
| `CLOSE_TOKEN_ACCOUNT` | `medium` | `12.5` (2nd medium) | emptied account closed, rent swept |
| `UNKNOWN_PROGRAM` | `medium` | `6.25` (3rd medium) | orchestrating program not in registry |

- **Score:** `45 + 25 + 12.5 + 6.25 = 88.75 → 89` (clamped/rounded).
- **Overall level:** `high` (the single highest finding).
- **Summary:** `Overall HIGH, 1 high, 3 medium signals.`
- **Ordering:** the `FULL_TOKEN_ACCOUNT_DRAIN` finding sorts to the top.

A reviewer sees, at a glance: *their own* token account was fully drained, SOL left the wallet, the empty account was closed to an unknown destination, and an unrecognized program was involved. Each finding's `evidence` names the mint, the amount, the destination, and the program ID. That is enough to recognize a drain.

### Worked example B: a routine swap (de-saturation in action)

The same person *intentionally* sells their entire `MEME` position on PumpSwap and receives ~1.2 SOL back, in a multi-hop route touching 13 writable accounts and a compute-budget instruction:

| Finding | Level | Why it fired |
| ------- | ----- | ------------ |
| `MANY_WRITABLE_ACCOUNTS` | `low` | 13 writable accounts in the route |
| `TOKEN_SWAP` | `low` | full sell, but SOL came back via a known DEX (relabel of what would have been a `high` drain) |
| `COMPUTE_BUDGET_SET` | `info` | priority-fee instruction |
| `NEW_ACCOUNT_CREATION` | `info` | a temporary token account created |

- **Score:** `10 + 5 = 15` (`low` weights `10` then `10 × 0.5`. `info` adds `0`).
- **Overall level:** `low`.
- **Summary:** `Overall LOW, 2 low, 2 info signals.`

The crucial contrast with the old engine: **before** the signer-owned restriction and the swap-aware downgrade, the same swap read its pool/WSOL legs and the full `MEME` sell as a `FULL_TOKEN_ACCOUNT_DRAIN` and pinned the score to `100`. Now it correctly reads `low`, which is exactly the regression the `npm test` suite ([§5](#5-tests)) guards.

---

## 7. Pre-sign simulation (shipped)

Pre-sign simulation is now **built and verified live**. It reviews an *unsigned* transaction *before* it is approved, which is the most direct way to put this reviewer inside an agent's signing loop. This is the headline feature, and it is done. The implementation lives in [`src/lib/presign.ts`](src/lib/presign.ts), entered from [`src/lib/review.ts`](src/lib/review.ts).

The flow:

1. Accept a base64-serialized **unsigned** `VersionedTransaction`, deserialize it, and resolve any address lookup tables (v0).
2. Simulate read-only: `connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: "base64", addresses: writableAccounts } })`.
3. Derive SOL and SPL token deltas by diffing the **pre-state** (`getMultipleAccountsInfo`) against the simulated **post-state** (token amount = u64 LE at byte 64; mint decimals from the mint account at byte 44).
4. Recover SPL Token + System instruction *types* from the raw instruction data with a small discriminator decoder, so the same `parsedType`-dependent heuristics (`setAuthority`, `approve`, `closeAccount`, `createAccount`, and so on) still fire.
5. Emit the **same** `ParsedTransaction` the confirmed path produces (with `simulated: true`), so the risk engine, the explanation, and the UI are unchanged. *Zero new risk logic.* The heuristics in this document apply unchanged to simulated effects.

Nothing is ever signed or sent. Simulation only.

**Verified live.** An unsigned transfer to the burn/incinerator address simulated successfully. It showed SOL deltas of -0.001005 (payer, including the fee) and +0.001 (burn), and the `FLAGGED_ADDRESS` watchlist rule fired **before** signing.

**Honest limitations of the pre-sign path:**
- The fee is **not** computed during simulation (it shows as not-applicable), so `HIGH_FEE` (§4.14) does not fire on a simulated transaction.
- The instruction-type decoder covers **SPL Token + System** only. Other programs' instruction types are not decoded, though balance, program, and watchlist heuristics still apply (see the note under §4).
- It needs a **custom RPC**, because public RPC rate-limits simulate-with-accounts.
- Because the blockhash is replaced, the real result after signing can differ if on-chain state changes before you submit.

**Token metadata enrichment is also shipped** ([`src/lib/metadata.ts`](src/lib/metadata.ts)). It resolves a mint to `{ symbol, name, logoURI }` via a small known-token registry (SOL/USDC/USDT/BONK/JUP/WIF/JTO) plus a cached, best-effort Jupiter datapi lookup (`https://datapi.jup.ag/v1/assets/search?query=<mint>`), with graceful fallback to the raw mint when a token is unknown or the endpoint is unreachable. Token tables and the explanation now show e.g. "USDC" and a logo instead of a raw mint and a base-unit delta. `enrichTokenMetadata()` runs in `reviewTransaction()` for **both** paths and never throws.

**UI surfaces.** The home page has a "Confirmed signature" / "Unsigned tx (pre-sign)" toggle (a textarea for the base64 tx). `ResultView` shows token symbols, plus a "SIMULATED" badge and "Would succeed / Would fail" for the pre-sign path. The shareable permalink is shown only for confirmed reviews. The simulated explanation is framed as "This is a read-only simulation of an unsigned transaction. If signed and sent now, it would…".

Two adjacent surfaces also shipped that make confirmed reviews shareable:

- **Shareable permalink.** `GET /tx/<signature>?cluster=…` ([`src/app/tx/[signature]/page.tsx`](src/app/tx/%5Bsignature%5D/page.tsx)) server-renders the full `reviewTransaction` pipeline (reusing `ResultView`, **no new risk logic**). The home page links to it as "Open shareable permalink."
- **OG unfurl card.** A Next 16 `ImageResponse` ([`src/app/tx/[signature]/opengraph-image.tsx`](src/app/tx/%5Bsignature%5D/opengraph-image.tsx)) renders the risk level + score + short signature so a pasted link unfurls into a risk preview. `metadataBase` comes from `NEXT_PUBLIC_SITE_URL`.

### What's next (estimates in agent-paced days)

With pre-sign simulation and token metadata done, the remaining milestones are:

- **Deepen the LLM guardrails (~2 days).** Tighten the prompt and the JSON contract, add provider-side validation, and harden the fallback so a misbehaving model can never inflate or contradict the deterministic risk verdict.
- **Richer program/IDL labeling + a CPI tree view (~3 days).** Resolve more programs to friendly names and, where an IDL is available, decode their instruction types so the instruction-level rules reach beyond SPL Token + System. Render the inner-instruction (CPI) structure as a tree.
- **Expanded heuristics, watchlist growth, and hardening (~3 days).** Add rules (e.g. a `freezeAccount` check), grow `KNOWN_PROGRAMS`, `DEX_PROGRAM_IDS`, and the watchlist with citable sources, and add more regression coverage. All of this follows the patterns in [§6](#6-extending-the-engine).

---

## 8. Extending the engine

The engine is built to grow. Common extensions:

### Adding a new rule

Each rule is a pure function `(tx: ParsedTransaction) => RiskFinding | RiskFinding[] | null` in [`src/lib/heuristics.ts`](src/lib/heuristics.ts).

1. **Write the function.** Return `null` when the pattern is absent. Otherwise return a `RiskFinding` (or an array, for per-occurrence rules) with a stable `id`, a clear `title`, the appropriate `level`, a `detail` explaining *why it matters*, and an `evidence` array of concrete facts.

   ```ts
   function checkFreezeAccount(tx: ParsedTransaction): RiskFinding | null {
     const froze = tx.instructions.some(
       (ix) => isToken(ix) && ix.parsedType === "freezeAccount",
     );
     if (!froze) return null;
     return {
       id: "FREEZE_TOKEN_ACCOUNT",
       title: "Freezes a token account",
       level: "high",
       detail:
         "A FreezeAccount blocks all transfers from a token account until it is thawed. Confirm the freeze authority is one you trust.",
       evidence: ["A token account is being frozen"],
     };
   }
   ```

2. **Register it.** Add the function to the `RULES` array. Order only affects pre-sort evaluation order. The final report is deduped and re-sorted by level.
3. **Pick a weight by choosing a level.** Levels map to weight via `LEVEL_WEIGHT` (info 0 / low 10 / medium 25 / high 45), then diminishing returns apply per level (§2). There is no separate per-rule weight to set. The level *is* the base weight.
4. **Use a threshold if it is tunable.** If your rule has a numeric cut-off, add it to `THRESHOLDS` and reference it, so it lives next to the others and stays documentable.
5. **Document it.** Add a subsection in [§4](#4-the-rules) and a row to the summary table, mirroring the existing format. Update the rule count.
6. **Add a regression check.** Mirror the pattern in [`tests/heuristics.test.ts`](tests/heuristics.test.ts) so the behavior is locked down.

### Adding a known program (and/or a DEX)

The registry lives in [`src/lib/programs.ts`](src/lib/programs.ts) as `KNOWN_PROGRAMS: Record<string, KnownProgram>`, keyed by base-58 program ID.

1. **Add an entry** mapping the program ID to a `{ name, category }`, where `category` is one of `system | token | defi | nft | infra | governance | other`:

   ```ts
   export const KNOWN_PROGRAMS: Record<string, KnownProgram> = {
     // ...existing entries...
     PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: {
       name: "Phoenix",
       category: "defi",
     },
   };
   ```

2. **If it is a swap venue/aggregator, also add its ID to `DEX_PROGRAM_IDS`** so `isDexProgram()` recognizes it and the swap-aware downgrade (§4.5) can relabel position exits routed through it.
3. **Effects, automatically:**
   - Instructions from that program get the friendly `name` in the UI.
   - The program no longer trips `UNKNOWN_PROGRAM` (§4.3), reducing false-positive noise.
   - If you give an entry one of the *name-matched* labels (`"BPF Loader (Upgradeable)"`, `"Compute Budget"`, `"Memo"`, or `"Memo (v1)"`) the corresponding name-based rule (§4.12, §4.17, §4.18) keys off that exact string. Use those names only for the programs they describe.

No other code changes are required. `resolveProgram()`, `isKnownProgram()`, and `isDexProgram()` read the maps directly.

### Adding a watchlist entry

The watchlist lives in [`src/lib/watchlist.ts`](src/lib/watchlist.ts). Add a `WatchEntry` to `FLAGGED_ADDRESSES` (wallets) or `FLAGGED_PROGRAMS` (program IDs) with an `address`, a `label`, a `category` (`drainer | scam | phishing | sanctioned | burn`), and a **citable `source`**. The matching is fully wired (`lookupWatch`), so no code change is needed. **Add entries only with a citable public source.** A false accusation is harmful, which is why `FLAGGED_PROGRAMS` ships empty.

---

## Contact & links

<!-- CONTACT PLACEHOLDER, replace before publishing -->
- **Project:** Solana Agentic Transaction Reviewer (proof-of-concept)
- **Grant:** Superteam Agentic Engineering micro-grant (~200 USDG, Solana Earn)
- **Repository:** https://github.com/plutohan/solana-agentic-tx-reviewer (public)
- **Maintainer / contact:** _TODO: add name, email, and links (X/Discord) here._
- **Payout wallet:** _TODO: add the Solana wallet address for the grant payout here._

---

### Appendix: implementation reference

- Engine: [`src/lib/heuristics.ts`](src/lib/heuristics.ts), `assessRisk`, `LEVEL_WEIGHT`, `THRESHOLDS`, `dedupeFindings`, `computeScore`, `buildSwapContext`, all rules.
- Data model: [`src/lib/types.ts`](src/lib/types.ts), `ParsedTransaction`, `RiskFinding`, `RiskReport`, `RiskLevel`.
- Pre-sign simulation: [`src/lib/presign.ts`](src/lib/presign.ts), `simulateAndReview`, entered from [`src/lib/review.ts`](src/lib/review.ts).
- Token metadata: [`src/lib/metadata.ts`](src/lib/metadata.ts), `enrichTokenMetadata`.
- Program registry: [`src/lib/programs.ts`](src/lib/programs.ts), `KNOWN_PROGRAMS`, `DEX_PROGRAM_IDS`, `WSOL_MINT`, `resolveProgram`, `isKnownProgram`, `isDexProgram`.
- Watchlist: [`src/lib/watchlist.ts`](src/lib/watchlist.ts), `FLAGGED_ADDRESSES`, `FLAGGED_PROGRAMS`, `lookupWatch`.
- AI narration (Anthropic/OpenAI behind a seam, free placeholder default): [`src/lib/ai.ts`](src/lib/ai.ts), `explainTransaction`, `buildPrompt`.
- Shareable permalink + OG card: [`src/app/tx/[signature]/page.tsx`](src/app/tx/%5Bsignature%5D/page.tsx), [`src/app/tx/[signature]/opengraph-image.tsx`](src/app/tx/%5Bsignature%5D/opengraph-image.tsx).
- Tests: [`tests/heuristics.test.ts`](tests/heuristics.test.ts), `npm test` (via `tsx`).

**Toolchain:** Node.js 24.16.0 LTS · npm 11.16.0 · Next.js 16.2.7 (App Router) · React 19.2.7 · TypeScript 6.0.3 · Tailwind CSS 4.3.0 (CSS-first, no `tailwind.config.js`) · `@solana/web3.js` 1.98.4 (the v1 line. v2 continues as `@solana/kit` 6.x, noted as a future option). The broader machine toolchain (Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2, kept current by the agent toolchain pass) is **not** used by this read-only web app.

**Scope reminder:** read-only analysis. No signing, no sending. Pre-sign *simulation* (§7) is shipped: it simulates an unsigned transaction read-only and never signs or sends. The heuristics are explainable signals to inform a human or an agent in the approval loop, not a security guarantee.
