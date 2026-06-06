# @solana-tx-reviewer/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP-capable agent (Claude, ElizaOS, custom runtimes) a read-only Solana transaction review tool. It runs locally in the agent's runtime, which is where a signing decision should be made.

## Tools
- **`review_transaction`** — provide a confirmed `signature` or an unsigned base64 `rawTransaction` (+ optional `cluster`). Returns the risk level (info/low/medium/high), a 0-100 score, the findings, a plain-English summary, and a **circuit-breaker `decision`** (`ALLOW` / `WARN` / `REQUIRE_HUMAN`). Calls the reviewer API (configurable). Use this before signing.
- **`assess_parsed_transaction`** — run the deterministic risk engine **locally, with no network**, on an already-normalized `ParsedTransaction`. Returns the `RiskReport`. This is the embedded [`@solana-tx-reviewer/core`](../core) primitive.

Read-only: it never signs or sends a transaction.

## Run

```bash
npm install -g @solana-tx-reviewer/mcp   # once published
solana-tx-reviewer-mcp                    # speaks JSON-RPC over stdio
```

Configure the reviewer endpoint with `REVIEWER_API_URL` (defaults to the public instance).

## Add to an MCP client

Claude Code / Claude Desktop style config:

```jsonc
{
  "mcpServers": {
    "solana-tx-reviewer": {
      "command": "solana-tx-reviewer-mcp",
      "env": { "REVIEWER_API_URL": "https://solana-agentic-tx-reviewer.vercel.app" }
    }
  }
}
```

Then an agent can call `review_transaction` before it signs and gate on the **circuit breaker**: do not auto-sign unless `decision.action === "ALLOW"`. Anything with irreversible blast radius (authority handovers, delegate approvals, value out, owner reassignment) returns `REQUIRE_HUMAN`.

## Roadmap
`review_transaction` currently calls the reviewer API. A fully local mode (fetch/simulate via RPC and assess with the embedded core, no hosted dependency) is the next step.

License: MIT.
