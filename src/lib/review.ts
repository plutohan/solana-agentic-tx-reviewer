/**
 * Orchestrates the full review pipeline: fetch -> parse -> risk -> explain.
 * This is the single function the API route (or any future agent) calls.
 */
import {
  assertSafeRpcUrl,
  fetchParsedTransaction,
  isValidSignature,
} from "./solana";
import { parseTransaction } from "./parse";
import { assessRisk } from "./heuristics";
import { explainTransaction } from "./ai";
import type { Cluster, ReviewRequest, ReviewResult } from "./types";

/** Typed error carrying an HTTP status for the API layer. */
export class ReviewError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReviewError";
    this.status = status;
  }
}

export async function reviewTransaction(
  request: ReviewRequest,
): Promise<ReviewResult> {
  const VALID_CLUSTERS: Cluster[] = ["mainnet-beta", "devnet", "testnet"];
  const cluster: Cluster = VALID_CLUSTERS.includes(request.cluster as Cluster)
    ? (request.cluster as Cluster)
    : "mainnet-beta";
  const signature = (request.signature ?? "").trim();

  if (!isValidSignature(signature)) {
    throw new ReviewError(
      "Invalid transaction signature. Expected an 86–88 character base58 string.",
    );
  }

  if (request.rpcUrl) {
    try {
      assertSafeRpcUrl(request.rpcUrl);
    } catch (e) {
      throw new ReviewError((e as Error).message, 400);
    }
  }

  let raw;
  try {
    raw = await fetchParsedTransaction(signature, cluster, request.rpcUrl);
  } catch (e) {
    throw new ReviewError(
      `RPC error while fetching the transaction: ${(e as Error).message}`,
      502,
    );
  }

  if (!raw) {
    throw new ReviewError(
      "Transaction not found. It may be too old for this RPC, on a different cluster, or not yet confirmed.",
      404,
    );
  }

  const transaction = parseTransaction(raw, signature, cluster);
  const risk = assessRisk(transaction);
  const explanation = await explainTransaction(transaction, risk);

  return {
    request: { signature, cluster, rpcUrl: request.rpcUrl },
    transaction,
    risk,
    explanation,
  };
}
