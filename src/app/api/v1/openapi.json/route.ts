/**
 * GET /api/v1/openapi.json -- machine-readable OpenAPI 3.1 spec for the public API.
 * Lets SDKs, agents, and tools discover the contract programmatically.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };

const riskLevel = { type: "string", enum: ["info", "low", "medium", "high"] };

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Solana Agentic Transaction Reviewer API",
    version: "1.0.0",
    description:
      "Read-only review of a Solana transaction. Submit a confirmed signature or an unsigned base64 transaction (simulated before signing) and get a deterministic risk report plus a plain-English explanation. Nothing is ever signed or sent.",
    license: { name: "MIT" },
  },
  servers: [
    { url: "https://solana-agentic-tx-reviewer.vercel.app", description: "Production" },
  ],
  paths: {
    "/api/v1/review": {
      post: {
        summary: "Review a transaction",
        description:
          "Provide exactly one of `signature` or `rawTransaction`. Rate limited per IP; optional `x-api-key` if the server enables keys.",
        operationId: "reviewTransaction",
        security: [{}, { ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReviewRequest" },
              examples: {
                confirmed: { summary: "Confirmed signature", value: { signature: "<base58-signature>", cluster: "mainnet-beta" } },
                presign: { summary: "Unsigned pre-sign", value: { rawTransaction: "<base64-unsigned-tx>", cluster: "mainnet-beta" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Review result",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ReviewResult" } } },
          },
          "400": { description: "Bad request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "Invalid or missing API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "413": { description: "Request body too large", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "500": { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "502": { description: "Upstream RPC error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
      ReviewRequest: {
        type: "object",
        description: "Provide exactly one of signature or rawTransaction.",
        properties: {
          signature: { type: "string", description: "Base58 confirmed transaction signature." },
          rawTransaction: { type: "string", description: "Base64-serialized unsigned transaction (simulated read-only)." },
          cluster: { type: "string", enum: ["mainnet-beta", "devnet", "testnet"], default: "mainnet-beta" },
        },
      },
      RiskFinding: {
        type: "object",
        properties: {
          id: { type: "string" },
          level: riskLevel,
          title: { type: "string" },
          detail: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["id", "level", "title", "detail"],
      },
      RiskReport: {
        type: "object",
        properties: {
          score: { type: "integer", minimum: 0, maximum: 100 },
          level: riskLevel,
          summary: { type: "string" },
          findings: { type: "array", items: { $ref: "#/components/schemas/RiskFinding" } },
        },
        required: ["score", "level", "summary", "findings"],
      },
      AiExplanation: {
        type: "object",
        properties: {
          provider: { type: "string", description: "anthropic | openai | placeholder" },
          model: { type: ["string", "null"] },
          summary: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          caveats: { type: "array", items: { type: "string" } },
          generatedAt: { type: "string" },
        },
        required: ["provider", "summary", "bullets", "caveats"],
      },
      ReviewResult: {
        type: "object",
        properties: {
          apiVersion: { type: "string", example: "v1" },
          request: { $ref: "#/components/schemas/ReviewRequest" },
          transaction: {
            type: "object",
            description: "Normalized transaction. Includes signature, cluster, success, simulated, feeSol, accounts, instructions, programsInvoked, tokenBalanceChanges, logMessages.",
            additionalProperties: true,
          },
          risk: { $ref: "#/components/schemas/RiskReport" },
          explanation: { $ref: "#/components/schemas/AiExplanation" },
        },
        required: ["transaction", "risk", "explanation"],
      },
    },
  },
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET() {
  return NextResponse.json(spec, { headers: CORS });
}
