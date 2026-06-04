/**
 * Solana RPC access layer.
 *
 * Read-only: we only ever call getParsedTransaction. No signing, no sending.
 */
import {
  Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import type { Cluster } from "./types";

const CLUSTER_RPC: Record<Cluster, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
};

/**
 * Resolve which RPC endpoint to use. Precedence:
 *   1. explicit rpcUrl from the request
 *   2. SOLANA_RPC_URL env var (mainnet only — keep it off devnet/testnet)
 *   3. the public cluster default
 */
export function resolveRpcUrl(
  cluster: Cluster = "mainnet-beta",
  rpcUrl?: string,
): string {
  if (rpcUrl && rpcUrl.trim()) return rpcUrl.trim();
  if (cluster === "mainnet-beta" && process.env.SOLANA_RPC_URL) {
    return process.env.SOLANA_RPC_URL;
  }
  return CLUSTER_RPC[cluster];
}

/** Cheap structural validation of a base58 transaction signature. */
export function isValidSignature(signature: string): boolean {
  if (!signature || typeof signature !== "string") return false;
  const trimmed = signature.trim();
  // Ed25519 signatures encode to ~86–88 base58 chars; allow a little slack.
  if (trimmed.length < 64 || trimmed.length > 90) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
}

const PRIVATE_HOST =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Guard against SSRF. The rpcUrl override is fetched server-side, so a hostile
 * client could otherwise point it at cloud metadata (169.254.169.254), loopback,
 * or internal services. Allow only http(s) to non-private hosts; throw otherwise.
 * (Local-validator users on http://localhost can relax this in a fork.)
 */
export function assertSafeRpcUrl(rpcUrl: string): void {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error("Invalid RPC URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("RPC URL must use http(s).");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    PRIVATE_HOST.test(host)
  ) {
    throw new Error("RPC URL host is not allowed.");
  }
}

export function getConnection(
  cluster: Cluster = "mainnet-beta",
  rpcUrl?: string,
): Connection {
  return new Connection(resolveRpcUrl(cluster, rpcUrl), "confirmed");
}

/**
 * Fetch a fully-parsed transaction. Returns null if the RPC has no record of
 * the signature (too old / wrong cluster / not yet confirmed).
 */
export async function fetchParsedTransaction(
  signature: string,
  cluster: Cluster = "mainnet-beta",
  rpcUrl?: string,
): Promise<ParsedTransactionWithMeta | null> {
  const connection = getConnection(cluster, rpcUrl);
  return connection.getParsedTransaction(signature.trim(), {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
}
