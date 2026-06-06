/**
 * Normalize a raw getParsedTransaction response into our ParsedTransaction model.
 *
 * This is the deterministic "extraction" layer. Everything downstream (risk
 * heuristics, the explanation, the UI) reads only the normalized shape, never
 * the raw RPC types.
 */
import type {
  ParsedTransactionWithMeta,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  ParsedMessageAccount,
  TokenBalance,
} from "@solana/web3.js";
import type {
  ParsedTransaction,
  AccountSummary,
  InstructionSummary,
  TokenBalanceChange,
  ProgramInvocation,
} from "./types";
import {
  resolveProgram,
  lamportsToSol,
  isLikelyPubkey,
  rawToUi,
} from "@solana-tx-reviewer/core";

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction;

function isParsed(ix: AnyInstruction): ix is ParsedInstruction {
  return "parsed" in ix;
}

function toInstructionSummary(
  ix: AnyInstruction,
  index: number,
  isInner: boolean,
  parentIndex?: number,
): InstructionSummary {
  const programId = ix.programId.toBase58();
  const summary: InstructionSummary = {
    index,
    programId,
    programName: resolveProgram(programId)?.name,
    accounts: [],
    isInner,
    parentIndex,
  };

  if (isParsed(ix)) {
    summary.program = ix.program;
    const parsed = ix.parsed as { type?: string; info?: unknown } | undefined;
    summary.parsedType = parsed?.type;
    if (parsed?.info && typeof parsed.info === "object") {
      summary.info = parsed.info as Record<string, unknown>;
      // Best-effort: surface any pubkey-shaped values as the instruction's accounts.
      summary.accounts = Object.values(parsed.info).filter(isLikelyPubkey);
    }
  } else {
    summary.accounts = ix.accounts.map((a) => a.toBase58());
  }

  return summary;
}

// rawToUi now lives in @solana-tx-reviewer/core; re-exported for existing imports.
export { rawToUi };

function computeTokenBalanceChanges(
  meta: ParsedTransactionWithMeta["meta"],
  accountKeys: ParsedMessageAccount[],
): TokenBalanceChange[] {
  const pre = meta?.preTokenBalances ?? [];
  const post = meta?.postTokenBalances ?? [];

  const byIndex = new Map<number, { pre?: TokenBalance; post?: TokenBalance }>();
  for (const b of pre) {
    byIndex.set(b.accountIndex, { ...byIndex.get(b.accountIndex), pre: b });
  }
  for (const b of post) {
    byIndex.set(b.accountIndex, { ...byIndex.get(b.accountIndex), post: b });
  }

  const changes: TokenBalanceChange[] = [];
  for (const [accountIndex, pair] of byIndex) {
    const ref = pair.post ?? pair.pre;
    if (!ref) continue;

    const decimals = ref.uiTokenAmount.decimals;
    const preRaw = pair.pre?.uiTokenAmount.amount ?? "0";
    const postRaw = pair.post?.uiTokenAmount.amount ?? "0";
    if (preRaw === postRaw) continue; // unchanged

    const uiPreAmount = rawToUi(preRaw, decimals);
    const uiPostAmount = rawToUi(postRaw, decimals);
    // Delta from the exact BigInt difference, not float subtraction.
    const delta = rawToUi((BigInt(postRaw) - BigInt(preRaw)).toString(), decimals);

    changes.push({
      accountIndex,
      account: accountKeys[accountIndex]?.pubkey.toBase58() ?? "",
      owner: pair.post?.owner ?? pair.pre?.owner ?? undefined,
      mint: ref.mint,
      decimals,
      preAmount: preRaw,
      postAmount: postRaw,
      uiPreAmount,
      uiPostAmount,
      delta,
    });
  }

  return changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export function parseTransaction(
  raw: ParsedTransactionWithMeta,
  signature: string,
  cluster: string,
): ParsedTransaction {
  const meta = raw.meta;
  const message = raw.transaction.message;
  const accountKeys = message.accountKeys as ParsedMessageAccount[];

  const preBalances = meta?.preBalances ?? [];
  const postBalances = meta?.postBalances ?? [];

  const accounts: AccountSummary[] = accountKeys.map((acc, i) => {
    const change = (postBalances[i] ?? 0) - (preBalances[i] ?? 0);
    return {
      index: i,
      pubkey: acc.pubkey.toBase58(),
      signer: acc.signer,
      writable: acc.writable,
      isProgram: false, // filled in after instructions are known
      solChangeLamports: change,
      solChangeSol: lamportsToSol(change),
    };
  });

  // Flatten top-level instructions, interleaving their inner (CPI) instructions.
  const innerByIndex = new Map<number, AnyInstruction[]>();
  for (const inner of meta?.innerInstructions ?? []) {
    innerByIndex.set(inner.index, inner.instructions as AnyInstruction[]);
  }

  const instructions: InstructionSummary[] = [];
  const topLevel = message.instructions as AnyInstruction[];
  let seq = 0;
  topLevel.forEach((ix, topIndex) => {
    const parent = toInstructionSummary(ix, seq++, false);
    instructions.push(parent);
    for (const innerIx of innerByIndex.get(topIndex) ?? []) {
      instructions.push(toInstructionSummary(innerIx, seq++, true, parent.index));
    }
  });

  // Mark which accounts are invoked as programs.
  const programIds = new Set(instructions.map((i) => i.programId));
  for (const acc of accounts) {
    if (programIds.has(acc.pubkey)) acc.isProgram = true;
  }

  // Aggregate program invocations across top-level + inner instructions.
  const counts = new Map<string, number>();
  for (const i of instructions) {
    counts.set(i.programId, (counts.get(i.programId) ?? 0) + 1);
  }
  const programsInvoked: ProgramInvocation[] = [...counts.entries()]
    .map(([programId, count]) => ({
      programId,
      name: resolveProgram(programId)?.name,
      count,
    }))
    .sort((a, b) => b.count - a.count);

  const err = meta?.err ?? null;
  const feeLamports = meta?.fee ?? 0;

  return {
    signature,
    cluster,
    slot: raw.slot,
    blockTime: raw.blockTime ?? null,
    success: err === null,
    err,
    feeLamports,
    feeSol: lamportsToSol(feeLamports),
    computeUnitsConsumed: meta?.computeUnitsConsumed,
    recentBlockhash: message.recentBlockhash,
    feePayer: accounts[0]?.pubkey ?? "",
    accounts,
    signers: accounts.filter((a) => a.signer).map((a) => a.pubkey),
    writableAccounts: accounts.filter((a) => a.writable).map((a) => a.pubkey),
    instructions,
    logMessages: meta?.logMessages ?? [],
    tokenBalanceChanges: computeTokenBalanceChanges(meta, accountKeys),
    programsInvoked,
    version: raw.version ?? "legacy",
  };
}
