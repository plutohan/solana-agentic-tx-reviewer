# Risk-engine benchmark

A reproducible, public measurement of the deterministic risk engine (`assessRisk` from [`@solana-tx-reviewer/core`](../packages/core)). Most "transaction security" tools never publish false-positive / false-negative numbers. This does.

```bash
npm run benchmark
```

## Method
- Each fixture is a labeled `ParsedTransaction` with a ground-truth `truth` (`benign` | `risky`).
- The decision is binary: **flagged = overall level `medium` or `high`**.
- From `truth` vs the engine's decision we compute the confusion matrix and precision / recall / F1 / accuracy.
- Each fixture also records `engineFlags` (the engine's current, documented decision). If a code change flips any fixture's classification, the runner exits non-zero. So this doubles as a **regression guard**.
- Two-plus fixtures are deliberate **FP / FN probes**, so the numbers are honest and not a self-graded 100%.

## Current results (17-fixture seed corpus)

| Metric | Value |
| --- | --- |
| Precision | 80.0% |
| Recall | 88.9% |
| F1 | 84.2% |
| Accuracy | 82.4% |
| Confusion | TP=8, FP=2, TN=6, FN=1 |

## Gaps this corpus surfaces (the improvement backlog)
1. **`CLOSE_TOKEN_ACCOUNT` over-flags (FP).** A standalone `closeAccount` (rent reclaim, ATA cleanup, WSOL unwrap) is usually benign but is flagged `medium`. It should require an additional drain signal.
2. **`UNKNOWN_PROGRAM` over-flags (FP).** A legitimate protocol not in the small registry trips `medium`. "Unknown" is not "malicious"; this needs a much larger program registry and/or a softer level.
3. **Dust-relabel evasion (FN).** A real drain that sends 2 base units of a junk token back through a DEX passes the weak `> 1` base-unit inflow guard and relabels to `TOKEN_SWAP` (low). The swap-back guard should be **value-based**, not a raw base-unit count.

## Attack database (the source of truth for fixtures + rules)
[`attacks.json`](attacks.json) + [`ATTACKS.md`](ATTACKS.md) are a **source-verified database of 90 real-world Solana transaction attacks** (deep multi-agent research, every entry cited to incidents/security-vendor reports/the SolPhishHunter paper). Each is tagged with whether a pre-sign simulation catches it, whether the action is irreversible, and which of our rules covers it or `GAP`.

Two headline numbers from it:
- **67 of 90 are not fully simulation-detectable** (25 "no", 42 "partial"). This is the case for static, instruction-level review over simulation-only tools.
- **38 of 90 are gaps** in our current rules. Those `suggestedRule` / `suggestedFixture` fields are the detection backlog and the next fixtures to add.

## Honest scope
The fixtures here are still a **synthetic seed corpus** (hand-built, no live RPC), so they measure rule logic, not real-world prevalence. The attack database above is the bridge: the next step is turning its entries (and captured on-chain transactions) into fixtures so precision/recall track real coverage as the corpus and the rules evolve.
