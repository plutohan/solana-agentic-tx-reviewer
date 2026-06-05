/**
 * Minimal Node example for the public review API.
 *
 * Run (no install needed, uses global fetch on Node 18+):
 *   node examples/node-review.mjs <signature>
 *
 * Or with the SDK once it is built/published:
 *   import { SolanaTxReviewer } from "solana-tx-reviewer-sdk";
 *   const r = await new SolanaTxReviewer().reviewSignature(sig);
 */
const BASE = process.env.REVIEWER_URL ?? "https://solana-agentic-tx-reviewer.vercel.app";
const signature = process.argv[2];

if (!signature) {
  console.error("Usage: node examples/node-review.mjs <signature>");
  process.exit(1);
}

const res = await fetch(`${BASE}/api/v1/review`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ signature, cluster: "mainnet-beta" }),
});

const data = await res.json();
if (!res.ok) {
  console.error("Error:", data.error);
  process.exit(1);
}

console.log(`Risk: ${data.risk.level.toUpperCase()} (${data.risk.score}/100)`);
console.log(`Summary: ${data.explanation.summary}\n`);
for (const f of data.risk.findings) {
  console.log(`  [${f.level}] ${f.title} - ${f.detail}`);
}
