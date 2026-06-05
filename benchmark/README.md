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

## Honest scope
This is a **synthetic seed corpus** (hand-built, no network), so it measures rule logic, not real-world prevalence. The next step is capturing real on-chain transactions (benign swaps across Jupiter/Raydium/Orca and known drainer/approval/authority-change incidents) into the same `Fixture` shape. The runner and metrics are built to grow with that; the goal is to track precision/recall as the corpus and the rules evolve.
