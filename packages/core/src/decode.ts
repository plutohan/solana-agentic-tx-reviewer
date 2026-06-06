/**
 * Pure instruction-discriminator decoder.
 *
 * Maps a program id + raw instruction data to the `parsedType` string the
 * jsonParsed RPC path emits, so the same heuristics fire on the pre-sign
 * (simulated) path. Zero dependencies; operates on any Uint8Array, so it works
 * in Node, the browser, and agent runtimes (no Buffer).
 */
import {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  MEMO_V1_PROGRAM_ID,
} from "./programs.js";

const TOKEN_PROGRAMS = new Set<string>([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
const MEMO_PROGRAMS = new Set<string>([MEMO_PROGRAM_ID, MEMO_V1_PROGRAM_ID]);

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
  4: "advanceNonce",
  5: "withdrawNonceAccount",
  6: "initializeNonceAccount",
  7: "authorizeNonceAccount",
  8: "allocate",
  9: "allocateWithSeed",
  10: "assignWithSeed",
  11: "transferWithSeed",
};
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

function readU32LE(data: Uint8Array): number | undefined {
  if (data.length < 4) return undefined;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}

export function decodeIxType(
  programId: string,
  data: Uint8Array,
): { program?: string; parsedType?: string } {
  if (TOKEN_PROGRAMS.has(programId)) {
    const program =
      programId === TOKEN_2022_PROGRAM_ID ? "spl-token-2022" : "spl-token";
    return { program, parsedType: data.length ? SPL_TOKEN_IX[data[0]] : undefined };
  }
  if (programId === SYSTEM_PROGRAM_ID) {
    const disc = readU32LE(data);
    return { program: "system", parsedType: disc === undefined ? undefined : SYSTEM_IX[disc] };
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
  if (MEMO_PROGRAMS.has(programId)) {
    return { program: "spl-memo", parsedType: "memo" };
  }
  return {};
}
