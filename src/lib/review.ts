/**
 * Orchestrates the full review pipeline.
 *
 * Two input modes share one output contract:
 *   - signature      -> fetch a CONFIRMED transaction (post-hoc review)
 *   - rawTransaction -> simulate an UNSIGNED transaction (pre-sign review)
 * Both produce a ParsedTransaction, then: enrich -> assessRisk -> explain.
 */
import {
  assertSafeRpcUrl,
  fetchParsedTransaction,
  isValidSignature,
} from "./solana";
import { parseTransaction } from "./parse";
import { simulateAndReview, PresignError } from "./presign";
import { enrichTokenMetadata } from "./metadata";
import { assessRisk } from "./heuristics";
import { explainTransaction } from "./ai";
import type {
  Cluster,
  ParsedTransaction,
  ReviewRequest,
  ReviewResult,
} from "./types";

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

  if (request.rpcUrl) {
    try {
      assertSafeRpcUrl(request.rpcUrl);
    } catch (e) {
      throw new ReviewError((e as Error).message, 400);
    }
  }

  const signature = (request.signature ?? "").trim();
  const rawTransaction = (request.rawTransaction ?? "").trim();

  let transaction: ParsedTransaction;

  if (rawTransaction) {
    // Pre-sign path: simulate an unsigned transaction (read-only).
    try {
      transaction = await simulateAndReview(rawTransaction, cluster, request.rpcUrl);
    } catch (e) {
      if (e instanceof PresignError) throw new ReviewError(e.message, e.status);
      throw new ReviewError(`Simulation failed: ${(e as Error).message}`, 500);
    }
  } else {
    // Confirmed path: review a signature.
    if (!isValidSignature(signature)) {
      throw new ReviewError(
        "Invalid transaction signature. Expected an 86–88 character base58 string. " +
          "To review an unsigned transaction, send a base64 `rawTransaction` instead.",
      );
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
    transaction = parseTransaction(raw, signature, cluster);
  }

  // Best-effort token metadata enrichment (never throws).
  await enrichTokenMetadata(transaction.tokenBalanceChanges);

  const risk = assessRisk(transaction);
  const explanation = await explainTransaction(transaction, risk);

  return {
    request: {
      signature: signature || undefined,
      cluster,
      rpcUrl: request.rpcUrl,
    },
    transaction,
    risk,
    explanation,
  };
}
