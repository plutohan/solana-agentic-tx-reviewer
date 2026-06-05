# @solana-tx-reviewer/core

The zero-dependency, zero-network heart of the [Solana Agentic Transaction Reviewer](https://solana-agentic-tx-reviewer.vercel.app). Feed it a normalized transaction and get back a deterministic risk report. No network, no private keys, no `@solana/web3.js`. Runs the same in Node, the browser, CI, and an agent runtime.

This is the review primitive other software can embed locally, instead of calling a hosted API in the signing path.

## Install

```bash
npm install @solana-tx-reviewer/core
```

## Use

```ts
import { assessRisk, type ParsedTransaction } from "@solana-tx-reviewer/core";

const report = assessRisk(parsedTx); // parsedTx: ParsedTransaction
// report.level: "info" | "low" | "medium" | "high"
// report.score: 0-100
// report.findings: { id, level, title, detail, evidence }[]
if (report.level === "high") block(report.findings);
```

## What's in it
- `assessRisk(tx)` — the deterministic 18-rule risk engine (signer-scoped drain detection, swap-aware relabeling, wrapped-SOL handling, de-saturated scoring), plus `LEVEL_WEIGHT` and `THRESHOLDS`.
- `resolveProgram` / `isKnownProgram` / `isDexProgram` / `DEX_PROGRAM_IDS` — the program registry.
- `decodeIxType(programId, data)` — a pure instruction-discriminator decoder (SPL Token, System, Compute Budget, Associated Token Account, Memo) over any `Uint8Array`.
- `lookupWatch` + the curated, best-effort `FLAGGED_ADDRESSES` watchlist.
- `rawToUi` and small formatting helpers.
- The shared types: `ParsedTransaction`, `RiskReport`, `RiskFinding`, `InstructionSummary`, and the rest.

## Boundaries
The core does NOT fetch or simulate transactions. Producing a `ParsedTransaction` from an RPC response or a simulation (which needs `@solana/web3.js`) lives in the host app, as does the optional LLM explanation. That keeps this package small, portable, and safe to run anywhere.

License: MIT.
