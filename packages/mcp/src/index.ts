#!/usr/bin/env node
/**
 * MCP server for the Solana Agentic Transaction Reviewer.
 *
 * Exposes two tools to any MCP-capable agent runtime:
 *   - review_transaction        : review a confirmed signature or an unsigned tx
 *                                 (calls the reviewer API; configurable URL).
 *   - assess_parsed_transaction : run the deterministic risk engine LOCALLY on an
 *                                 already-normalized ParsedTransaction (no network).
 *
 * Read-only. It never signs or sends a transaction. Speaks JSON-RPC over stdio.
 *
 * Env: REVIEWER_API_URL (default: the public instance).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  assessRisk,
  decide,
  type ParsedTransaction,
  type RiskReport,
} from "@solana-tx-reviewer/core";

const BASE_URL =
  process.env.REVIEWER_API_URL ?? "https://solana-agentic-tx-reviewer.vercel.app";

const TOOLS = [
  {
    name: "review_transaction",
    description:
      "Review a Solana transaction before or after signing. Provide a confirmed `signature` OR an unsigned base64 `rawTransaction`. Returns a deterministic risk level (info/low/medium/high), a 0-100 score, the findings, a plain-English summary, and a circuit-breaker `decision` (ALLOW / WARN / REQUIRE_HUMAN) keyed on irreversibility. Gate on it: do not auto-sign unless decision.action is ALLOW. Read-only; never signs or sends.",
    inputSchema: {
      type: "object",
      properties: {
        signature: { type: "string", description: "Base58 confirmed transaction signature." },
        rawTransaction: { type: "string", description: "Base64 unsigned transaction (simulated read-only, before signing)." },
        cluster: { type: "string", enum: ["mainnet-beta", "devnet", "testnet"], description: "Default mainnet-beta." },
      },
    },
  },
  {
    name: "assess_parsed_transaction",
    description:
      "Run the deterministic risk engine LOCALLY (no network) on an already-normalized ParsedTransaction. Returns the RiskReport (score, level, findings) plus a circuit-breaker `decision` (ALLOW / WARN / REQUIRE_HUMAN). Use when you already hold the parsed transaction shape.",
    inputSchema: {
      type: "object",
      properties: {
        transaction: { type: "object", description: "A ParsedTransaction object (the reviewer's normalized shape)." },
      },
      required: ["transaction"],
    },
  },
];

const server = new Server(
  { name: "solana-tx-reviewer", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    if (name === "assess_parsed_transaction") {
      const tx = args.transaction as ParsedTransaction | undefined;
      if (!tx || typeof tx !== "object") {
        throw new Error("Provide `transaction` (a ParsedTransaction object).");
      }
      const report = assessRisk(tx);
      const decision = decide(report);
      return { content: [{ type: "text", text: JSON.stringify({ ...report, decision }, null, 2) }] };
    }

    if (name === "review_transaction") {
      const signature = args.signature as string | undefined;
      const rawTransaction = args.rawTransaction as string | undefined;
      const cluster = (args.cluster as string | undefined) ?? "mainnet-beta";
      if (!signature && !rawTransaction) {
        throw new Error("Provide `signature` or `rawTransaction`.");
      }
      const res = await fetch(`${BASE_URL}/api/v1/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature, rawTransaction, cluster }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error((data.error as string) ?? `HTTP ${res.status}`);
      }
      const tx = data.transaction as Record<string, unknown> | undefined;
      const explanation = data.explanation as Record<string, unknown> | undefined;
      const out = {
        risk: data.risk,
        decision: data.risk ? decide(data.risk as RiskReport) : undefined,
        summary: explanation?.summary,
        success: tx?.success,
        simulated: tx?.simulated ?? false,
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (e) {
    return {
      content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr only.
  console.error(`solana-tx-reviewer MCP server running (reviewer: ${BASE_URL})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
