/**
 * Sample generators for the "Load a sample" button, so the live demo always has
 * something valid to review (never an empty box or a pruned signature).
 *
 * The unsigned sample is built fresh server-side (a tiny transfer to the burn
 * address), so it always simulates and always trips the watchlist. The signature
 * sample is a recent successful transaction from a busy program.
 */
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
} from "@solana/web3.js";
import { getConnection } from "./solana";
import { SYSTEM_PROGRAM_ID } from "./programs";
import type { Cluster } from "./types";

const BURN_ADDRESS = "1nc1nerator11111111111111111111111111111111";
const BUSY = [
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
];

/** A funded, System-owned account = the fee payer of a recent confirmed tx. */
async function fundedPayer(conn: Connection): Promise<PublicKey | null> {
  for (const src of BUSY) {
    try {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(src), {
        limit: 15,
      });
      for (const s of sigs) {
        if (s.err) continue;
        const p = await conn.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
        });
        const fp = p?.transaction?.message?.accountKeys?.[0]?.pubkey;
        if (!fp) continue;
        const info = await conn.getAccountInfo(fp);
        if (
          info &&
          info.owner.toBase58() === SYSTEM_PROGRAM_ID &&
          info.lamports > 5_000_000
        ) {
          return fp;
        }
      }
    } catch {
      // try the next source
    }
  }
  return null;
}

/** Build a fresh base64 unsigned transaction (a 0.001 SOL transfer to the burn address). */
export async function sampleUnsignedTransaction(
  cluster: Cluster = "mainnet-beta",
  rpcUrl?: string,
): Promise<string> {
  const conn = getConnection(cluster, rpcUrl);
  const payer = await fundedPayer(conn);
  if (!payer) throw new Error("Could not build a sample (RPC unavailable).");
  const { blockhash } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey(BURN_ADDRESS),
        lamports: 1_000_000,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString(
    "base64",
  );
}

/** A recent successful transaction signature from a busy program. */
export async function sampleSignature(
  cluster: Cluster = "mainnet-beta",
  rpcUrl?: string,
): Promise<string> {
  const conn = getConnection(cluster, rpcUrl);
  for (const src of BUSY) {
    try {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(src), {
        limit: 15,
      });
      const ok = sigs.find((s) => !s.err);
      if (ok) return ok.signature;
    } catch {
      // try the next source
    }
  }
  throw new Error("Could not fetch a sample signature (RPC unavailable).");
}
