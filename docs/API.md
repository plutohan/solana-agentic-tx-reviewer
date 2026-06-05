# Public API

A stable, versioned HTTP API for reviewing Solana transactions. Submit a confirmed signature or an unsigned transaction and get a deterministic risk report plus a plain-English explanation. It is read-only and never signs or sends anything.

- Base URL: `https://solana-agentic-tx-reviewer.vercel.app`
- Machine spec (OpenAPI 3.1): `GET /api/v1/openapi.json`
- Official SDK: [`solana-tx-reviewer-sdk`](../sdk) (see its README)

## POST /api/v1/review

Provide exactly one of `signature` or `rawTransaction`.

### Request

```jsonc
{
  "signature": "5xy...",          // base58 confirmed transaction signature
  // OR
  "rawTransaction": "AQAB...",    // base64 UNSIGNED transaction, simulated before signing
  "cluster": "mainnet-beta"        // optional: mainnet-beta | devnet | testnet
}
```

Headers: `Content-Type: application/json`. If the server enables keys (`PUBLIC_API_KEYS`), also send `x-api-key: <key>`.

### Response 200

```jsonc
{
  "apiVersion": "v1",
  "transaction": {
    "signature": "5xy...",         // "(unsigned)" for the pre-sign path
    "cluster": "mainnet-beta",
    "success": true,
    "simulated": false,             // true when reviewing an unsigned tx
    "feeSol": 0.000005,
    "programsInvoked": [{ "programId": "...", "name": "Jupiter Aggregator v6", "count": 2 }],
    "tokenBalanceChanges": [{ "owner": "...", "mint": "...", "symbol": "USDC", "delta": -12.5, "decimals": 6 }]
    // ...accounts, instructions (incl. CPIs), logMessages, slot, blockTime
  },
  "risk": {
    "score": 35,
    "level": "medium",              // info | low | medium | high
    "summary": "...",
    "findings": [{ "id": "TOKEN_SWAP", "level": "low", "title": "...", "detail": "...", "evidence": ["..."] }]
  },
  "explanation": {
    "provider": "anthropic",        // anthropic | openai | placeholder
    "model": "claude-haiku-4-5",
    "summary": "...",
    "bullets": ["..."],
    "caveats": ["..."]
  }
}
```

### Errors

`{ "error": "..." }` with status `400` (bad input), `401` (bad/missing API key), `429` (rate limited), or `500`.

## Behavior and limits

- **CORS** is open (`*`), so wallets and agents can call it directly from the browser.
- **Rate limiting** is best-effort per IP (`X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` on 429). Serverless instances do not share memory, so production-grade limits need a shared store (Upstash/Redis); that is on the roadmap.
- **No client RPC override.** Unlike the internal endpoint, the public API ignores any `rpcUrl` and always uses the server's configured RPC. This removes the SSRF surface for public callers.
- **Read-only.** No private keys are accepted. The pre-sign path only simulates.

## Examples

curl:

```bash
curl -s https://solana-agentic-tx-reviewer.vercel.app/api/v1/review \
  -H 'content-type: application/json' \
  -d '{"signature":"<sig>","cluster":"mainnet-beta"}'
```

SDK:

```ts
import { SolanaTxReviewer } from "solana-tx-reviewer-sdk";
const reviewer = new SolanaTxReviewer();
const r = await reviewer.reviewUnsigned(base64UnsignedTx);
if (r.risk.level === "high") block(r.risk.findings);
```

See [`examples/node-review.mjs`](../examples/node-review.mjs) and [`examples/usePreSignReview.ts`](../examples/usePreSignReview.ts).
