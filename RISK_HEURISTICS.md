# Risk Heuristics

This document is the authoritative specification for the risk engine in the **Solana Agentic Transaction Reviewer**. It is written to match the implementation in [`src/lib/heuristics.ts`](src/lib/heuristics.ts) exactly. If the code and this document ever diverge, the code wins — but they are meant to stay in lock-step, so please update both together.

> **What this tool is.** A lightweight, AI-assisted, **read-only** Solana transaction reviewer. You paste a transaction signature; the app fetches it over RPC, normalizes it into a shared data model, runs the deterministic heuristics described here, and produces a human-readable explanation plus a risk report. It is a proof-of-concept built for the Superteam Agentic Engineering Grant. It does **not** sign, send, simulate, or mutate anything on-chain.

**Pipeline.** `RPC fetch → parse() → assessRisk() → explainTransaction() → ReviewResult`

The risk engine is the `assessRisk()` step. Its input is a `ParsedTransaction` (see [`src/lib/types.ts`](src/lib/types.ts)); its output is a `RiskReport`.

---

## 1. Philosophy

The risk engine produces **explainable signals, not a verdict.**

- **Signals, not a score of guilt.** Every finding describes a pattern a careful human reviewer would look for — drains, authority handovers, delegate approvals, unrecognized programs. A finding tells you *what is happening* and *why it is worth a second look*. It does **not** assert that a transaction is malicious. Many high-severity findings (a full token-account drain, a large SOL outflow, a `closeAccount`) are perfectly legitimate in the right context. The job of the engine is to make those moments visible so a human can judge them.
- **Deterministic.** Given the same `ParsedTransaction`, the engine always returns the same `RiskReport`. There is no randomness, no model temperature, no network call, and no hidden state. Each rule is a pure function of the parsed transaction. This makes the report reproducible, testable, and auditable — you can read a rule and know precisely when it fires.
- **No LLM in the risk path.** The language model never decides risk. The optional AI layer ([`src/lib/ai.ts`](src/lib/ai.ts)) only *narrates* the transaction and the already-computed findings into plain English. Today that layer is a deterministic template (`provider: "placeholder"`), so the PoC runs with **zero API keys and zero cost**. Swapping in a real model would not change a single score — risk is computed before the explanation is generated.
- **Small and curated, on purpose.** The program registry ([`src/lib/programs.ts`](src/lib/programs.ts)) and the rule set are deliberately compact for the PoC. They are designed to be extended (see [§6](#6-extending-the-engine)), not to be exhaustive on day one.

The guiding principle: **be useful before you sign, and fast to debug after.** A reviewer should be able to glance at the report, understand what moved and what changed control, and decide whether to proceed.

---

## 2. Scoring model

The report has two headline numbers, both derived from the list of findings.

### Per-level weight

Each finding carries a `level`. Levels map to a numeric weight via `LEVEL_WEIGHT`:

| Level    | Weight |
| -------- | -----: |
| `info`   |      0 |
| `low`    |     10 |
| `medium` |     25 |
| `high`   |     45 |

### Score

```
score = clamp( Σ LEVEL_WEIGHT[finding.level],  0,  100 )
```

The score is the **sum of the weights of every finding**, clamped to the inclusive range `0..100`. Because findings add up, a transaction can reach 100 either with a few high-severity signals or with many lower-severity ones. `info` findings contribute `0`, so they never move the score — they exist to add context, not weight.

> Worked arithmetic: two `high` findings = `45 + 45 = 90`. Add a `medium` (`+25`) and the raw sum is `115`, which clamps to `100`.

### Overall level

```
level = max( finding.level  for each finding )   // by rank, not by weight
```

The overall `level` is the **single highest finding level present**, ranked `info < low < medium < high` (`LEVEL_RANK`). It is *not* derived from the score. A transaction with one `high` finding is `high` overall even if its score is well under 100; a transaction with twelve `info` findings is still `info` overall with a score of `0`.

### Ordering and summary

- Findings are **sorted by level, highest first**, so the most important signal is always at the top of the report.
- The `summary` string counts findings per level, e.g. `Overall HIGH — 2 high, 1 medium, 1 info signals.`
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

## 3. Thresholds

All tunable cut-offs live in the `THRESHOLDS` object in [`src/lib/heuristics.ts`](src/lib/heuristics.ts). Changing a value here changes when the corresponding rule fires — no other code needs to move.

| Threshold              | Value      | Unit                  | Used by                                    |
| ---------------------- | ---------- | --------------------- | ------------------------------------------ |
| `largeSolOutflow`      | `1`        | SOL                   | `LARGE_SOL_OUTFLOW` (medium trigger)       |
| `veryLargeSolOutflow`  | `10`       | SOL                   | `LARGE_SOL_OUTFLOW` (high escalation)      |
| `manyWritableAccounts` | `12`       | count of accounts     | `MANY_WRITABLE_ACCOUNTS`                   |
| `highFeeSol`           | `0.01`     | SOL                   | `HIGH_FEE`                                 |
| `largeTokenOutflowPct` | `0.5`      | fraction of pre-balance | `LARGE_TOKEN_OUTFLOW` (entry threshold)  |

Two related constants are not in `THRESHOLDS` but are part of the same family:

- The `LARGE_TOKEN_OUTFLOW` rule escalates from `low` to `medium` at a hard-coded **90% (`0.9`)** of the prior balance.
- The set of programs treated as token programs for instruction-level rules is `TOKEN_PROGRAMS = { "spl-token", "spl-token-2022" }` (matched against the RPC's parsed `program` label, not the program ID).

---

## 4. The rules

There are 16 rules, evaluated in the order they appear in the `RULES` array. A rule returns one finding, an array of findings, or `null`. The summary table is followed by one subsection per rule.

| # | ID | Level(s) | Trigger (short) |
| - | -- | -------- | --------------- |
| 1 | `TX_FAILED` | `info` | `meta.err != null` (`tx.success === false`) |
| 2 | `UNKNOWN_PROGRAM` | `medium` | invokes ≥1 program not in the registry |
| 3 | `LARGE_SOL_OUTFLOW` | `medium` (≥1 SOL) / `high` (≥10 SOL) | fee payer net SOL decrease past threshold |
| 4 | `FULL_TOKEN_ACCOUNT_DRAIN` | `high` | token account `pre > 0` and `post == 0` |
| 5 | `LARGE_TOKEN_OUTFLOW` | `low` (≥50%) / `medium` (≥90%) | partial token decrease as a % of prior balance |
| 6 | `SET_AUTHORITY` | `high` | spl-token `setAuthority` |
| 7 | `ACCOUNT_REASSIGN` | `medium` | system `assign` |
| 8 | `TOKEN_DELEGATE_APPROVE` | `medium` | spl-token `approve` / `approveChecked` |
| 9 | `CLOSE_TOKEN_ACCOUNT` | `medium` | spl-token `closeAccount` |
| 10 | `PROGRAM_DEPLOY_OR_UPGRADE` | `medium` | BPF Upgradeable Loader involved |
| 11 | `MANY_WRITABLE_ACCOUNTS` | `low` | writable account count ≥ 12 |
| 12 | `HIGH_FEE` | `low` | fee > 0.01 SOL |
| 13 | `NEW_ACCOUNT_CREATION` | `info` | system `createAccount` / `createAccountWithSeed` / `allocate` |
| 14 | `MULTIPLE_SIGNERS` | `info` | more than 1 signer |
| 15 | `COMPUTE_BUDGET_SET` | `info` | Compute Budget program used |
| 16 | `MEMO_PRESENT` | `info` | Memo program used |

> Note on counting: rules 1, 2, 3, 10, 11, 12, 13, 14, 15, and 16 emit **at most one** finding per transaction (they collapse all matches into a single finding). Rules 4, 5, 6, 7, 8, and 9 are **per-occurrence** — they can emit multiple findings if the pattern appears multiple times, and each one adds its weight to the score.

---

### 4.1 `TX_FAILED` — Transaction failed on-chain

- **Level:** `info`
- **Trigger:** `tx.success === false` (i.e. `meta.err != null` in the raw RPC response).
- **Rationale:** A failed transaction's instructions had **no lasting effect** beyond the fee paid. Failure is not itself dangerous, but it can be a tell — a misconfigured client, a slippage/deadline failure, or a hostile interaction that reverted. Surfacing it explains *why nothing moved* and prevents a reviewer from mistaking a no-op for a clean run.
- **Evidence:** `Error: <JSON of tx.err>`.
- **Example:** A swap that exceeded its slippage tolerance reverts; the report shows `TX_FAILED` and the underlying error object.
- **False positive / negative:** Not applicable in the risk sense — this is a factual flag. It is `info` precisely because "failed" ≠ "risky." Note that a failed transaction still pays a fee, so a `HIGH_FEE` finding can legitimately co-occur.

---

### 4.2 `UNKNOWN_PROGRAM` — Interacts with unrecognized program(s)

- **Level:** `medium`
- **Trigger:** At least one entry in `tx.programsInvoked` has a `programId` that is **not** present in `KNOWN_PROGRAMS` (`isKnownProgram(programId) === false`). All such programs are reported in a single finding.
- **Rationale:** The registry is a small, curated allow-list of well-known programs (System, SPL Token, Jupiter, Raydium, Orca, pump.fun, Metaplex, etc.). A program outside it is simply *unrecognized by this tool* — which is the most common honest signal in practice, because the registry is intentionally small. It is worth a glance because unknown code is where novel risk hides.
- **Evidence:** One line per unknown program: `<programId> (<n> instruction(s))`.
- **Example:** A legitimate but niche DeFi protocol not yet in the registry triggers a single `UNKNOWN_PROGRAM` finding listing its program ID and invocation count.
- **False positive / negative:**
  - **False positive (very common):** Most unknown programs are benign. The registry covers only a handful of programs, so any real-world DeFi/NFT app will likely trip this. Treat it as "verify you trust this program," not "this is malicious."
  - **False negative:** A *known* program can still be used maliciously (e.g. a malicious `approve` through the genuine SPL Token program). This rule says nothing about how a known program is used — the instruction-level rules (§4.6–§4.9) cover that.
  - **Mitigation:** Add trustworthy programs to `KNOWN_PROGRAMS` ([§6](#6-extending-the-engine)) to reduce noise.

---

### 4.3 `LARGE_SOL_OUTFLOW` — Signing wallet sends a large amount of SOL

- **Level:** `medium` when outflow ≥ `largeSolOutflow` (1 SOL); escalates to `high` when outflow ≥ `veryLargeSolOutflow` (10 SOL).
- **Trigger:** The fee payer's **net** SOL change is negative and the magnitude exceeds the threshold. Concretely: `outflow = -feePayer.solChangeSol`; the rule fires when `outflow > 1`, and is `high` when `outflow >= 10`. `solChangeSol` is post-balance minus pre-balance, so this captures the *net* effect including the fee.
- **Rationale:** A large net decrease in the signer's SOL is the single most consequential thing a transaction can do to a wallet's native balance. Large outflows are equally common in legitimate transfers and in drains, so the rule flags the *magnitude*, not the intent.
- **Evidence:** `Net change for <shortPubkey(feePayer)>: -<amount> SOL (includes <fee> SOL fee)`.
- **Example:** A wallet sends 12 SOL to an exchange deposit address → net change ≈ -12 SOL → `high`. A 2 SOL purchase → `medium`.
- **False positive / negative:**
  - **False positive:** Intended large transfers (paying an invoice, funding a new wallet, an NFT mint) look identical to a drain by this metric. That is by design — the reviewer confirms the destination.
  - **False negative:** Because this measures the *fee payer's net* change, a drain that empties a **token** account (no SOL movement) or sends SOL out of a **non-signer** account will not trip this rule. Those are caught by the token rules (§4.4–§4.5) instead. Also, a transaction where the wallet both sends and receives SOL nets out and may fall below the threshold.

---

### 4.4 `FULL_TOKEN_ACCOUNT_DRAIN` — Token account fully drained

- **Level:** `high`
- **Trigger:** For any entry in `tx.tokenBalanceChanges`, `uiPreAmount > 0` **and** `uiPostAmount === 0`. One finding per drained account.
- **Rationale:** A token account going from a positive balance to exactly zero is the signature pattern of a wallet drain or a full position exit. It is high-impact and unambiguous about *what happened* (everything left), if not *why*.
- **Evidence:** `<owner-or-account> sent its entire balance of mint <mint>`.
- **Example:** A USDC token account with 5,000 USDC pre-balance reads 0 post-balance → one `high` finding.
- **False positive / negative:**
  - **False positive:** Legitimate full exits look identical — selling an entire token position, consolidating, or closing out a stablecoin balance to move it elsewhere. High severity is intentional so the reviewer always sees it.
  - **False negative:** A drain that leaves a dust remainder (post-balance `> 0`) escapes this exact rule, but a large-enough remainder-leaving outflow is caught by `LARGE_TOKEN_OUTFLOW` (§4.5). This rule depends on `pre/postTokenBalances` being present in the RPC response; if the RPC omits them (rare for recent, unpruned transactions), token changes cannot be assessed.

---

### 4.5 `LARGE_TOKEN_OUTFLOW` — Large partial token outflow

- **Level:** `medium` when the outflow is ≥ 90% of the prior balance; otherwise `low` (down to the 50% entry threshold).
- **Trigger:** For a token balance change with `delta < 0` and `uiPreAmount > 0`, compute `pct = |delta| / uiPreAmount`. The rule fires when `pct >= largeTokenOutflowPct` (0.5). Within that, `level = pct >= 0.9 ? "medium" : "low"`. One finding per qualifying account.
- **Rationale:** A token account shedding a large *fraction* of its balance is a softer version of a full drain. The percentage framing means a 60%-of-balance move is flagged whether the balance is 10 tokens or 10 million — the *proportion* is what matters to the holder.
- **Evidence:** `<owner-or-account> sent <amount> of mint <mint> (<pct>% of its prior balance)`.
- **Example:** A token account holding 1,000 of a mint sends 950 (95%) → `medium`. Sending 600 (60%) → `low`.
- **False positive / negative:**
  - **Relationship to §4.4:** This rule and `FULL_TOKEN_ACCOUNT_DRAIN` are mutually exclusive per account. The code checks the full-drain condition first (`pre > 0 && post == 0`); only if that is false does it evaluate the partial-outflow branch. So a 100% outflow is reported as a `high` drain, never as a `medium` outflow.
  - **False positive:** Rebalancing, partial sells, and routing a large trade all produce large legitimate outflows.
  - **False negative:** Outflows below 50% of the prior balance produce **no** finding here. An account that starts at zero (`uiPreAmount === 0`) is never flagged, since percentage-of-balance is undefined.

---

### 4.6 `SET_AUTHORITY` — Changes a token account / mint authority

- **Level:** `high`
- **Trigger:** A flattened instruction whose parsed `program` is a token program (`spl-token` / `spl-token-2022`) and whose `parsedType === "setAuthority"`. One finding per occurrence.
- **Rationale:** `SetAuthority` transfers *control* of a token account or mint (owner, close, mint, or freeze authority). Handing over authority is among the highest-impact actions in SPL Token and is a common step in account takeovers — control can outlast a single transaction.
- **Evidence:** `Sets <authorityType> to <shortPubkey(newAuthority)>` (falls back to `"authority"` / `"a new authority"` when the parsed `info` is absent).
- **Example:** An instruction sets the `AccountOwner` authority of a token account to an unfamiliar address → `high`.
- **False positive / negative:**
  - **False positive:** Legitimate during mint setup, revoking a mint authority (setting it to none), or migrating account ownership in a controlled flow.
  - **False negative:** Requires the RPC to return a *parsed* instruction. If a program performs an equivalent control change through its own (unparsed) instruction layout, the `parsedType` will not be `setAuthority` and this rule will not fire. Inner/CPI instructions are included in the flattened list, so CPI-driven `setAuthority` calls are covered when parsed.

---

### 4.7 `ACCOUNT_REASSIGN` — Reassigns account ownership (System Assign)

- **Level:** `medium`
- **Trigger:** An instruction with parsed `program === "system"` and `parsedType === "assign"`. One finding per occurrence.
- **Rationale:** A System `Assign` changes which *program* owns an account. Reassigning ownership hands the account's future behavior to a different program — meaningful for account-level control and worth confirming against the operation you intended.
- **Evidence:** `Assigns to owner <shortPubkey(owner)>`.
- **Example:** A setup flow assigns a freshly created account to a custom program → `medium`.
- **False positive / negative:**
  - **False positive:** Common and benign during account initialization (create-then-assign patterns). Medium severity reflects "verify this is expected," not "this is wrong."
  - **False negative:** Only matches the parsed System `assign` type; ownership transfers performed by other means are not detected here.

---

### 4.8 `TOKEN_DELEGATE_APPROVE` — Approves a token delegate

- **Level:** `medium`
- **Trigger:** A token-program instruction with `parsedType === "approve"` **or** `parsedType === "approveChecked"`. One finding per occurrence.
- **Rationale:** `Approve` grants another address (a delegate) the standing right to move tokens out of the account *later*, without a fresh signature. Malicious dApps abuse delegate approvals to set up a drain they execute after you have moved on. This is one of the most important "looks harmless now, dangerous later" patterns in SPL Token.
- **Evidence:** `Delegate <shortPubkey(delegate)> approved for <amount>` (amount is read from `info.amount`, falling back to `info.tokenAmount.amount`, then to `"an amount"`).
- **Example:** A "connect and approve" flow grants an unfamiliar delegate approval for a very large amount → `medium`.
- **False positive / negative:**
  - **False positive:** Many legitimate protocols (lending, escrow, some DEX flows) use delegation as a normal mechanic.
  - **False negative:** Only `approve` / `approveChecked` parsed types match. The rule flags the *grant*; it cannot know whether the delegate will ever act on it. A reviewer should weigh the delegate's identity and the approved amount.

---

### 4.9 `CLOSE_TOKEN_ACCOUNT` — Closes a token account

- **Level:** `medium`
- **Trigger:** A token-program instruction with `parsedType === "closeAccount"`. One finding per occurrence.
- **Rationale:** `CloseAccount` reclaims an account's rent lamports to a destination and removes the account. Benign as routine cleanup, but it is also the *final step of a drain* — empty the tokens, then close the account and sweep the rent. Surfacing the destination lets the reviewer check where the reclaimed lamports go.
- **Evidence:** `Closes <shortPubkey(account)> → <shortPubkey(destination)>`.
- **Example:** After a token balance is moved out, the empty account is closed with rent sent to an unfamiliar destination → `medium` (and likely alongside §4.4).
- **False positive / negative:**
  - **False positive:** Wallets routinely close empty associated token accounts to recover rent — entirely benign.
  - **False negative:** Only the parsed `closeAccount` type matches. A close performed via an unparsed instruction layout would be missed.

---

### 4.10 `PROGRAM_DEPLOY_OR_UPGRADE` — Interacts with the upgradeable loader

- **Level:** `medium`
- **Trigger:** Any entry in `tx.programsInvoked` whose resolved `name` is `"BPF Loader (Upgradeable)"` (program ID `BPFLoaderUpgradeab1e11111111111111111111111`). At most one finding.
- **Rationale:** Touching the BPF Upgradeable Loader means a program deploy, an upgrade, or an upgrade-authority change — high-impact developer operations that change *code* on-chain. For a developer reviewing their own deploy this is expected; encountering it unexpectedly is a strong reason to verify the target program.
- **Evidence:** None beyond the title (no `evidence` array is attached).
- **Example:** A program upgrade transaction lists the upgradeable loader among its invoked programs → `medium`.
- **False positive / negative:**
  - **False positive:** Routine and expected for developers shipping or upgrading programs.
  - **False negative:** This matches on the resolved program *name*, so it depends on the program ID being mapped to that exact name in the registry. The non-upgradeable `BPFLoader2` is a separate registry entry and does **not** trigger this rule.

---

### 4.11 `MANY_WRITABLE_ACCOUNTS` — Large writable surface

- **Level:** `low`
- **Trigger:** `tx.writableAccounts.length >= manyWritableAccounts` (≥ 12). At most one finding.
- **Rationale:** The number of *writable* accounts is the breadth of state a transaction can modify. A large writable set is normal for complex DeFi routes (multi-hop swaps, aggregators), but a broad write surface is worth a glance, especially on an otherwise simple-looking transaction.
- **Evidence:** None beyond the title (the count appears in the title itself, e.g. `14 writable accounts`).
- **Example:** A Jupiter multi-hop swap touching 15 writable accounts → `low`.
- **False positive / negative:**
  - **False positive (common):** Aggregated swaps and complex DeFi legitimately exceed 12 writable accounts all the time. This is a low-severity nudge, not an alarm.
  - **False negative:** A damaging transaction can touch very few writable accounts (e.g. a single `setAuthority`). Account *count* is a coarse signal; the specific instruction rules carry the weight.

---

### 4.12 `HIGH_FEE` — Elevated fee

- **Level:** `low`
- **Trigger:** `tx.feeSol > highFeeSol` (> 0.01 SOL).
- **Rationale:** The base fee on Solana is tiny; a fee above this threshold almost always reflects a **priority fee**. Not risky on its own, but notable — unusually high fees can indicate congestion bidding or, occasionally, a misconfigured client.
- **Evidence:** None beyond the title (the fee appears in the title, e.g. `Elevated fee (0.0150 SOL)`).
- **Example:** A transaction submitted during congestion with a large priority fee → `low`.
- **False positive / negative:**
  - **False positive:** Entirely normal during network congestion or for latency-sensitive trades.
  - **False negative:** A perfectly normal fee says nothing about the transaction's *effects*; a cheap transaction can still be a drain.

---

### 4.13 `NEW_ACCOUNT_CREATION` — Creates new accounts

- **Level:** `info`
- **Trigger:** One or more instructions with parsed `program === "system"` and `parsedType` in `{ createAccount, createAccountWithSeed, allocate }`. At most one finding (the count is aggregated).
- **Rationale:** Creating accounts is routine — new token accounts, program state, PDAs. It is surfaced as context (especially common on first-time interactions with a protocol), and contributes `0` to the score.
- **Evidence:** None beyond the title (`Creates N new account(s)`).
- **Example:** A first swap on a new token creates the associated token account → `info`.
- **False positive / negative:** Informational only. Account creation is so common that it carries no weight; it exists to explain *why* rent was spent and new accounts appeared.

---

### 4.14 `MULTIPLE_SIGNERS` — More than one signer

- **Level:** `info`
- **Trigger:** `tx.signers.length > 1`.
- **Rationale:** Multiple signers are expected in multisig or co-signed flows. Surfacing it is useful because an *unexpected* co-signer is worth checking — but on its own it is neutral.
- **Evidence:** None beyond the title (`N signers`).
- **Example:** A multisig-approved transfer with two signers → `info`.
- **False positive / negative:** Informational. The rule cannot tell an expected co-signer from a suspicious one — that judgment is left to the reviewer.

---

### 4.15 `COMPUTE_BUDGET_SET` — Sets a compute budget

- **Level:** `info`
- **Trigger:** Any entry in `tx.programsInvoked` with resolved `name === "Compute Budget"` (program ID `ComputeBudget111111111111111111111111111111`).
- **Rationale:** Compute Budget instructions set compute-unit limits and prices (the mechanism behind priority fees). They are routine for essentially all modern transactions and are surfaced purely as context.
- **Evidence:** None beyond the title.
- **Example:** Nearly any current wallet transaction includes a compute-budget instruction → `info`.
- **False positive / negative:** Informational and near-ubiquitous. It pairs naturally with `HIGH_FEE` to explain an elevated fee.

---

### 4.16 `MEMO_PRESENT` — Attaches a memo

- **Level:** `info`
- **Trigger:** Any entry in `tx.programsInvoked` whose resolved `name` is `"Memo"` or `"Memo (v1)"` (program IDs `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` and `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`).
- **Rationale:** A Memo instruction attaches a note to the transaction. It is commonly used by exchanges and CEX deposit flows, so its presence is a helpful hint about *who* the counterparty might be.
- **Evidence:** None beyond the title.
- **Example:** A CEX deposit that requires a memo tag → `info`.
- **False positive / negative:** Informational. A memo's *content* is not parsed or judged by this rule.

---

## 5. How to read a report

1. **Start at the overall `level` and `summary`.** The level is the highest single finding present; the summary counts findings by level. This is your one-line gut check.
2. **Glance at the `score` for intensity.** A high level with a low score means "one serious thing"; a high score means "a lot is happening." Both deserve a look, for different reasons.
3. **Read findings top-down.** They are sorted highest-severity first. For each, read the `title`, the `detail` (why it matters), and the `evidence` (the concrete facts: which account, which mint, which amount, which destination).
4. **Decide.** The engine never decides for you. Its job is to make the consequential moments — what moved, what changed control — impossible to miss.

> **Remember:** these are signals, not verdicts. A `high` overall level frequently describes a perfectly legitimate transaction (a big transfer, a full position exit). The value is that you *saw it and confirmed it* before signing, or understood it quickly while debugging.

### Worked example: a hypothetical wallet drain

Imagine a transaction where a victim, tricked into signing, does the following in one transaction:

- A USDC token account holding **5,000 USDC** goes to **0** (`pre = 5000`, `post = 0`).
- The signing wallet's **native SOL** drops by **~3 SOL** net (sent to an attacker address).
- The now-empty USDC token account is **closed**, with the reclaimed rent sent to the attacker.
- The transaction touches an **unrecognized program** that orchestrated the drain.

The engine would produce roughly:

| Finding | Level | Weight | Why it fired |
| ------- | ----- | -----: | ------------ |
| `FULL_TOKEN_ACCOUNT_DRAIN` | `high` | 45 | USDC account went 5,000 → 0 |
| `LARGE_SOL_OUTFLOW` | `medium` | 25 | fee payer net −3 SOL (≥ 1, < 10 SOL) |
| `CLOSE_TOKEN_ACCOUNT` | `medium` | 25 | emptied account closed, rent swept |
| `UNKNOWN_PROGRAM` | `medium` | 25 | orchestrating program not in registry |

- **Raw score:** `45 + 25 + 25 + 25 = 120` → **clamps to `100`**.
- **Overall level:** `high` (the single highest finding).
- **Summary:** `Overall HIGH — 1 high, 3 medium signals.`
- **Ordering:** the `FULL_TOKEN_ACCOUNT_DRAIN` finding sorts to the top.

A reviewer sees, at a glance: a token account was fully drained, SOL left the wallet, the empty account was closed to an unknown destination, and an unrecognized program was involved. Each finding's `evidence` names the mint, the amount, the destination, and the program ID. That is enough to recognize a drain — and, crucially, enough to recognize a *legitimate* full exit if that is what it actually was.

> Contrast: a clean ordinary swap on a known DEX might yield `COMPUTE_BUDGET_SET` (`info`), `NEW_ACCOUNT_CREATION` (`info`), and maybe `MANY_WRITABLE_ACCOUNTS` (`low`) — overall level `low`, score `10`. Nothing changed control; nothing was drained.

---

## 6. Extending the engine

The engine is built to grow. Two common extensions:

### Adding a new rule

Each rule is a pure function `(tx: ParsedTransaction) => RiskFinding | RiskFinding[] | null` in [`src/lib/heuristics.ts`](src/lib/heuristics.ts).

1. **Write the function.** Return `null` when the pattern is absent; otherwise return a `RiskFinding` (or an array, for per-occurrence rules) with a stable `id`, a clear `title`, the appropriate `level`, a `detail` explaining *why it matters*, and an `evidence` array of concrete facts.

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

2. **Register it.** Add the function to the `RULES` array. Order only affects pre-sort evaluation order; the final report is re-sorted by level.
3. **Pick a weight by choosing a level.** Levels map to weight via `LEVEL_WEIGHT` (info 0 / low 10 / medium 25 / high 45). There is no separate per-rule weight to set — the level *is* the weight.
4. **Use a threshold if it is tunable.** If your rule has a numeric cut-off, add it to `THRESHOLDS` and reference it, so it lives next to the others and stays documentable.
5. **Document it.** Add a subsection in [§4](#4-the-rules) and a row to the summary table, mirroring the existing format (id, level(s), trigger, rationale, example, false-positive/negative notes).

### Adding a known program

The registry lives in [`src/lib/programs.ts`](src/lib/programs.ts) as `KNOWN_PROGRAMS: Record<string, KnownProgram>`, keyed by base-58 program ID.

1. **Add an entry** mapping the program ID to a `{ name, category }`, where `category` is one of `system | token | defi | nft | infra | governance | other`:

   ```ts
   export const KNOWN_PROGRAMS: Record<string, KnownProgram> = {
     // ...existing entries...
     PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: {
       name: "Phoenix DEX",
       category: "defi",
     },
   };
   ```

2. **Effects, automatically:**
   - Instructions from that program get the friendly `name` in the UI.
   - The program no longer trips `UNKNOWN_PROGRAM` (§4.2), reducing false-positive noise.
   - If you give an entry one of the *name-matched* labels — `"BPF Loader (Upgradeable)"`, `"Compute Budget"`, `"Memo"`, or `"Memo (v1)"` — the corresponding name-based rule (§4.10, §4.15, §4.16) keys off that exact string. Use those names only for the programs they describe.

No other code changes are required: `resolveProgram()` and `isKnownProgram()` read the map directly.

---

## Contact & links

<!-- CONTACT PLACEHOLDER — replace before publishing -->
- **Project:** Solana Agentic Transaction Reviewer (proof-of-concept)
- **Grant:** Superteam Agentic Engineering Grant
- **Maintainer / contact:** _TODO: add name, email, and links (repo, demo, X/Discord) here._

---

### Appendix: implementation reference

- Engine: [`src/lib/heuristics.ts`](src/lib/heuristics.ts) — `assessRisk`, `LEVEL_WEIGHT`, `THRESHOLDS`, all rules.
- Data model: [`src/lib/types.ts`](src/lib/types.ts) — `ParsedTransaction`, `RiskFinding`, `RiskReport`, `RiskLevel`.
- Program registry: [`src/lib/programs.ts`](src/lib/programs.ts) — `KNOWN_PROGRAMS`, `resolveProgram`, `isKnownProgram`.
- AI narration (placeholder today): [`src/lib/ai.ts`](src/lib/ai.ts) — `explainTransaction`, `buildPrompt`.

**Toolchain:** Node.js 24.16.0 LTS · npm 11.16.0 · Next.js 16.2.7 (App Router) · React 19.2.7 · TypeScript 6.0.3 · Tailwind CSS 4.3.0 (CSS-first, no `tailwind.config.js`) · `@solana/web3.js` 1.98.4 (the v1 line; v2 continues as `@solana/kit` 6.x, noted as a future option). The broader machine toolchain (Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2) is current but **not** used by this read-only web app.

**Scope reminder:** read-only analysis. No signing, no sending, no simulation, no new protocol. The heuristics are signals to inform a human, not a security guarantee.
