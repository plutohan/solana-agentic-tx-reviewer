/**
 * Reference wallet hook: review an unsigned transaction BEFORE signing.
 *
 * This is the integration shape a wallet or agent would use. Serialize the
 * transaction you are about to sign to base64, ask the reviewer what it would
 * do, and gate the signature on the verdict.
 *
 * Framework-agnostic core + a thin React hook. Depends only on the SDK.
 */
import {
  SolanaTxReviewer,
  type ReviewResult,
  type Cluster,
} from "solana-tx-reviewer-sdk";

// --- Framework-agnostic core ---------------------------------------------

const reviewer = new SolanaTxReviewer();

/**
 * Serialize an unsigned web3.js transaction (v1 or VersionedTransaction) to the
 * base64 the API expects. Pass `requireSignatures: false` so an unsigned tx
 * serializes cleanly.
 */
export function serializeUnsigned(tx: {
  serialize: (opts?: { requireAllSignatures?: boolean; verifySignatures?: boolean }) => Uint8Array;
}): string {
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return Buffer.from(bytes).toString("base64");
}

/** Returns the review verdict for an unsigned transaction. Throws on transport errors. */
export async function reviewBeforeSigning(
  rawTransactionBase64: string,
  cluster: Cluster = "mainnet-beta",
): Promise<ReviewResult> {
  return reviewer.reviewUnsigned(rawTransactionBase64, cluster);
}

/** A simple gate: block high risk, warn on medium. */
export function shouldBlock(result: ReviewResult): boolean {
  return result.risk.level === "high";
}

// --- React hook (optional) -----------------------------------------------
// import { useState, useCallback } from "react";
//
// export function usePreSignReview(cluster: Cluster = "mainnet-beta") {
//   const [result, setResult] = useState<ReviewResult | null>(null);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//
//   const review = useCallback(async (rawTransactionBase64: string) => {
//     setLoading(true);
//     setError(null);
//     try {
//       const r = await reviewBeforeSigning(rawTransactionBase64, cluster);
//       setResult(r);
//       return r;
//     } catch (e) {
//       setError((e as Error).message);
//       throw e;
//     } finally {
//       setLoading(false);
//     }
//   }, [cluster]);
//
//   return { review, result, loading, error, blocked: result ? shouldBlock(result) : false };
// }
