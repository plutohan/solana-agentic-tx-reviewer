# solana-tx-reviewer-sdk

A tiny, dependency-free TypeScript client for the [Solana Agentic Transaction Reviewer](https://solana-agentic-tx-reviewer.vercel.app) API. Give it a confirmed signature or an unsigned transaction and get back a deterministic risk report plus a plain-English explanation. It is read-only and never signs or sends anything.

Built for wallets and agents that want a review step before they sign.

## Install

```bash
npm install solana-tx-reviewer-sdk
```

Works in Node 18+ and modern browsers (uses the global `fetch`).

## Use

```ts
import { SolanaTxReviewer } from "solana-tx-reviewer-sdk";

const reviewer = new SolanaTxReviewer();
// or point at your own deployment / pass an API key:
// new SolanaTxReviewer({ baseUrl: "https://your-host", apiKey: "..." });

// 1. Review a confirmed transaction
const r = await reviewer.reviewSignature("5xy...signature");
console.log(r.risk.level, r.risk.score, r.explanation.summary);

// 2. Review an UNSIGNED transaction before signing (the important one)
const verdict = await reviewer.reviewUnsigned(base64UnsignedTx);
if (verdict.risk.level === "high") {
  throw new Error("Refusing to sign: " + verdict.risk.findings.map((f) => f.title).join(", "));
}
```

## API

- `new SolanaTxReviewer(options?)` / `createReviewer(options?)`
  - `baseUrl` (default: the public instance), `apiKey`, `fetch`, `timeoutMs` (default 30000).
- `reviewSignature(signature, cluster?)` -> `Promise<ReviewResult>`
- `reviewUnsigned(rawTransactionBase64, cluster?)` -> `Promise<ReviewResult>`
- `review({ signature | rawTransaction, cluster })` -> `Promise<ReviewResult>`
- `openapi()` -> the machine-readable OpenAPI spec

Errors throw `ReviewerError` with a `.status`. Everything is fully typed (`ReviewResult`, `RiskReport`, `RiskFinding`, `AiExplanation`, ...).

## The shape you get back

```ts
interface ReviewResult {
  transaction: ParsedTransaction; // accounts, instructions (incl. CPIs), token + SOL deltas, programs
  risk: { score: number; level: "info" | "low" | "medium" | "high"; summary: string; findings: RiskFinding[] };
  explanation: { provider: string; model?: string; summary: string; bullets: string[]; caveats: string[] };
}
```

## Notes

- The public endpoint is rate limited per IP and may require an `x-api-key`.
- `reviewUnsigned` simulates the transaction read-only on the server, so you see what it would do without signing.
- License: MIT.
