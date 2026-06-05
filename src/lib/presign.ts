/**
 * Pre-sign path: review an UNSIGNED transaction before approving it.
 *
 * Accepts a base64-serialized VersionedTransaction, simulates it read-only
 * (sigVerify off, blockhash replaced), and derives SOL + SPL token deltas by
 * diffing the pre-state (getMultipleAccountsInfo) against the simulated
 * post-state. The output is the SAME ParsedTransaction the confirmed path
 * produces, so heuristics, the explanation, and the UI are unchanged.
 *
 * Nothing is ever signed or sent. Simulation only.
 */
import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  type AddressLookupTableAccount,
  type Connection,
} from "@solana/web3.js";
import type {
  Cluster,
  ParsedTransaction,
  AccountSummary,
  InstructionSummary,
  TokenBalanceChange,
  ProgramInvocation,
} from "./types";
import {
  resolveProgram,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./programs";
import { lamportsToSol } from "./format";
import { rawToUi } from "./parse";
import { getConnection } from "./solana";

/** Error carrying an HTTP status, mirroring ReviewError for the API layer. */
export class PresignError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PresignError";
    this.status = status;
  }
}

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

// Map raw instruction discriminators back to the parsedType strings the
// confirmed (jsonParsed) path emits, so the same heuristics fire pre-sign.
const SPL_TOKEN_IX: Record<number, string> = {
  1: "initializeAccount",
  3: "transfer",
  4: "approve",
  5: "revoke",
  6: "setAuthority",
  7: "mintTo",
  8: "burn",
  9: "closeAccount",
  10: "freezeAccount",
  11: "thawAccount",
  12: "transferChecked",
  13: "approveChecked",
  14: "mintToChecked",
  15: "burnChecked",
  16: "initializeAccount2",
  17: "syncNative",
  18: "initializeAccount3",
};
const SYSTEM_IX: Record<number, string> = {
  0: "createAccount",
  1: "assign",
  2: "transfer",
  3: "createAccountWithSeed",
  8: "allocate",
  9: "allocateWithSeed",
  10: "assignWithSeed",
  11: "transferWithSeed",
};
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_PROGRAM_IDS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);
const COMPUTE_BUDGET_IX: Record<number, string> = {
  0: "requestUnits",
  1: "requestHeapFrame",
  2: "setComputeUnitLimit",
  3: "setComputeUnitPrice",
};
const ASSOCIATED_TOKEN_IX: Record<number, string> = {
  0: "create",
  1: "createIdempotent",
  2: "recoverNested",
};

export function decodeIxType(
  programId: string,
  data: Buffer,
): { program?: string; parsedType?: string } {
  if (TOKEN_PROGRAMS.has(programId)) {
    const program =
      programId === TOKEN_2022_PROGRAM_ID ? "spl-token-2022" : "spl-token";
    return { program, parsedType: data.length ? SPL_TOKEN_IX[data[0]] : undefined };
  }
  if (programId === SYSTEM_PROGRAM_ID) {
    const type = data.length >= 4 ? SYSTEM_IX[data.readUInt32LE(0)] : undefined;
    return { program: "system", parsedType: type };
  }
  if (programId === COMPUTE_BUDGET_PROGRAM_ID) {
    return {
      program: "compute-budget",
      parsedType: data.length ? COMPUTE_BUDGET_IX[data[0]] : undefined,
    };
  }
  if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
    // The original Create instruction carries no data; later variants use a
    // single-byte discriminator.
    const parsedType = data.length === 0 ? "create" : ASSOCIATED_TOKEN_IX[data[0]];
    return { program: "spl-associated-token-account", parsedType };
  }
  if (MEMO_PROGRAM_IDS.has(programId)) {
    return { program: "spl-memo", parsedType: "memo" };
  }
  return {};
}

interface AccountState {
  owner: string;
  data: Buffer;
  lamports: number;
}

function tokenFields(
  state: AccountState | null,
): { mint: string; owner: string; amount: bigint } | null {
  if (!state || !TOKEN_PROGRAMS.has(state.owner) || state.data.length < 72) {
    return null;
  }
  try {
    return {
      mint: new PublicKey(state.data.subarray(0, 32)).toBase58(),
      owner: new PublicKey(state.data.subarray(32, 64)).toBase58(),
      amount: state.data.readBigUInt64LE(64),
    };
  } catch {
    return null;
  }
}

function mintDecimals(data: Buffer | null): number {
  // SPL Mint layout: mintAuthorityOption(4) + mintAuthority(32) + supply(8) + decimals(1)@44
  return data && data.length >= 45 ? data[44] : 0;
}

export async function simulateAndReview(
  rawBase64: string,
  cluster: Cluster = "mainnet-beta",
  rpcUrl?: string,
): Promise<ParsedTransaction> {
  const connection = getConnection(cluster, rpcUrl);

  // 1. Deserialize the unsigned transaction.
  let vtx: VersionedTransaction;
  try {
    const buf = Buffer.from(rawBase64.trim(), "base64");
    if (buf.length === 0 || buf.length > 1644) throw new Error("bad size");
    vtx = VersionedTransaction.deserialize(buf);
  } catch {
    throw new PresignError(
      "Could not decode the transaction. Provide a base64-serialized (unsigned) Solana transaction.",
    );
  }
  const message = vtx.message;

  // 2. Resolve any address lookup tables (v0).
  const altAccounts: AddressLookupTableAccount[] = [];
  const lookups =
    "addressTableLookups" in message ? message.addressTableLookups : [];
  for (const lookup of lookups) {
    let res;
    try {
      res = await connection.getAddressLookupTable(lookup.accountKey);
    } catch (e) {
      throw new PresignError(`RPC error resolving a lookup table: ${(e as Error).message}`, 502);
    }
    if (!res.value) {
      throw new PresignError("An address lookup table referenced by the transaction was not found.");
    }
    altAccounts.push(res.value);
  }

  const accountKeys =
    lookups.length > 0
      ? message.getAccountKeys({ addressLookupTableAccounts: altAccounts })
      : message.getAccountKeys();
  const numKeys = accountKeys.length;
  const pubkeys: string[] = [];
  for (let i = 0; i < numKeys; i++) {
    pubkeys.push(accountKeys.get(i)!.toBase58());
  }

  const signers: string[] = [];
  const writable: string[] = [];
  for (let i = 0; i < numKeys; i++) {
    if (message.isAccountSigner(i)) signers.push(pubkeys[i]);
    if (message.isAccountWritable(i)) writable.push(pubkeys[i]);
  }

  // 3. Fetch pre-state for the writable accounts.
  let preInfos;
  try {
    preInfos = await connection.getMultipleAccountsInfo(
      writable.map((p) => new PublicKey(p)),
    );
  } catch (e) {
    throw new PresignError(`RPC error fetching pre-state: ${(e as Error).message}`, 502);
  }

  // 4. Simulate read-only, requesting post-state for the same writable accounts.
  let sim;
  try {
    sim = await connection.simulateTransaction(vtx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      innerInstructions: true,
      accounts: { encoding: "base64", addresses: writable },
    });
  } catch (e) {
    throw new PresignError(`Simulation RPC error: ${(e as Error).message}`, 502);
  }
  const value = sim.value;
  const postRaw = value.accounts ?? [];

  // Index pre/post state by pubkey.
  const pre = new Map<string, AccountState | null>();
  const post = new Map<string, AccountState | null>();
  writable.forEach((pk, i) => {
    const p = preInfos[i];
    pre.set(pk, p ? { owner: p.owner.toBase58(), data: p.data, lamports: p.lamports } : null);
    const q = postRaw[i];
    post.set(
      pk,
      q ? { owner: q.owner, data: Buffer.from(q.data[0], "base64"), lamports: q.lamports } : null,
    );
  });

  // 5. SOL deltas per account (only writable accounts can change).
  const writableSet = new Set(writable);
  const accounts: AccountSummary[] = pubkeys.map((pubkey, index) => {
    let change = 0;
    if (writableSet.has(pubkey)) {
      change = (post.get(pubkey)?.lamports ?? 0) - (pre.get(pubkey)?.lamports ?? 0);
    }
    return {
      index,
      pubkey,
      signer: signers.includes(pubkey),
      writable: writableSet.has(pubkey),
      isProgram: false,
      solChangeLamports: change,
      solChangeSol: lamportsToSol(change),
    };
  });

  // 6. Token balance changes (diff token accounts pre vs post).
  interface RawChange {
    account: string;
    owner: string;
    mint: string;
    preAmount: string;
    postAmount: string;
  }
  const rawChanges: RawChange[] = [];
  const mints = new Set<string>();
  for (const pk of writable) {
    const preTok = tokenFields(pre.get(pk) ?? null);
    const postTok = tokenFields(post.get(pk) ?? null);
    if (!preTok && !postTok) continue;
    const ref = postTok ?? preTok!;
    const preAmt = preTok?.amount ?? 0n;
    const postAmt = postTok?.amount ?? 0n;
    if (preAmt === postAmt) continue;
    mints.add(ref.mint);
    rawChanges.push({
      account: pk,
      owner: ref.owner,
      mint: ref.mint,
      preAmount: preAmt.toString(),
      postAmount: postAmt.toString(),
    });
  }

  // Fetch mint decimals for the changed mints.
  const decimalsByMint = new Map<string, number>();
  if (mints.size > 0) {
    try {
      const mintList = [...mints];
      const mintInfos = await connection.getMultipleAccountsInfo(
        mintList.map((m) => new PublicKey(m)),
      );
      mintList.forEach((m, i) => decimalsByMint.set(m, mintDecimals(mintInfos[i]?.data ?? null)));
    } catch {
      // Non-fatal: fall back to 0 decimals (raw amounts still shown).
    }
  }

  const tokenBalanceChanges: TokenBalanceChange[] = rawChanges
    .map((c, index) => {
      const decimals = decimalsByMint.get(c.mint) ?? 0;
      const uiPreAmount = rawToUi(c.preAmount, decimals);
      const uiPostAmount = rawToUi(c.postAmount, decimals);
      const delta = rawToUi((BigInt(c.postAmount) - BigInt(c.preAmount)).toString(), decimals);
      return {
        accountIndex: index,
        account: c.account,
        owner: c.owner,
        mint: c.mint,
        decimals,
        preAmount: c.preAmount,
        postAmount: c.postAmount,
        uiPreAmount,
        uiPostAmount,
        delta,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // 7. Instructions: top-level via decompile (full data), inner from simulation.
  const instructions: InstructionSummary[] = [];
  let seq = 0;
  let decompiled;
  try {
    decompiled = TransactionMessage.decompile(message, {
      addressLookupTableAccounts: altAccounts,
    });
  } catch {
    decompiled = null;
  }

  const innerByIndex = new Map<number, { programId: string; accounts: string[] }[]>();
  for (const inner of (value as { innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[] }[] }[] }).innerInstructions ?? []) {
    innerByIndex.set(
      inner.index,
      inner.instructions.map((ix) => ({
        programId: pubkeys[ix.programIdIndex] ?? "",
        accounts: (ix.accounts ?? []).map((a) => pubkeys[a] ?? ""),
      })),
    );
  }

  (decompiled?.instructions ?? []).forEach((ix, topIndex) => {
    const programId = ix.programId.toBase58();
    const decoded = decodeIxType(programId, ix.data as Buffer);
    const parent: InstructionSummary = {
      index: seq++,
      programId,
      programName: resolveProgram(programId)?.name,
      program: decoded.program,
      parsedType: decoded.parsedType,
      accounts: ix.keys.map((k) => k.pubkey.toBase58()),
      isInner: false,
    };
    instructions.push(parent);
    for (const inner of innerByIndex.get(topIndex) ?? []) {
      instructions.push({
        index: seq++,
        programId: inner.programId,
        programName: resolveProgram(inner.programId)?.name,
        accounts: inner.accounts,
        isInner: true,
        parentIndex: parent.index,
      });
    }
  });

  // 8. Programs invoked + program flag on accounts.
  const programIds = new Set(instructions.map((i) => i.programId));
  for (const acc of accounts) if (programIds.has(acc.pubkey)) acc.isProgram = true;

  const counts = new Map<string, number>();
  for (const i of instructions) counts.set(i.programId, (counts.get(i.programId) ?? 0) + 1);
  const programsInvoked: ProgramInvocation[] = [...counts.entries()]
    .map(([programId, count]) => ({ programId, name: resolveProgram(programId)?.name, count }))
    .sort((a, b) => b.count - a.count);

  // Best-effort fee estimate. Returns null if the RPC cannot price the message
  // (e.g. a stale blockhash); fee then stays 0 and the UI shows it as unknown.
  let feeLamports = 0;
  try {
    const feeRes = await connection.getFeeForMessage(message, "confirmed");
    feeLamports = feeRes.value ?? 0;
  } catch {
    // leave at 0
  }

  const err = value.err ?? null;
  return {
    signature: "(unsigned)",
    cluster,
    slot: 0,
    blockTime: null,
    success: err === null,
    err,
    feeLamports,
    feeSol: lamportsToSol(feeLamports),
    computeUnitsConsumed: value.unitsConsumed,
    recentBlockhash: ("recentBlockhash" in message ? message.recentBlockhash : "") || "",
    feePayer: pubkeys[0] ?? "",
    accounts,
    signers,
    writableAccounts: writable,
    instructions,
    logMessages: value.logs ?? [],
    tokenBalanceChanges,
    programsInvoked,
    version: vtx.version,
    simulated: true,
  };
}
