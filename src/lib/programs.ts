/**
 * Registry of well-known Solana program IDs.
 *
 * Used to (a) give instructions human-friendly names and (b) flag interactions
 * with programs we don't recognize as a risk signal. This is intentionally a
 * small, curated set for the PoC — it is trivial to extend.
 */

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_V1_PROGRAM_ID = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
export const BPF_LOADER_UPGRADEABLE_ID =
  "BPFLoaderUpgradeab1e11111111111111111111111";

export type ProgramCategory =
  | "system"
  | "token"
  | "defi"
  | "nft"
  | "infra"
  | "governance"
  | "other";

export interface KnownProgram {
  name: string;
  category: ProgramCategory;
}

export const KNOWN_PROGRAMS: Record<string, KnownProgram> = {
  [SYSTEM_PROGRAM_ID]: { name: "System Program", category: "system" },
  [TOKEN_PROGRAM_ID]: { name: "SPL Token", category: "token" },
  [TOKEN_2022_PROGRAM_ID]: { name: "SPL Token-2022", category: "token" },
  [ASSOCIATED_TOKEN_PROGRAM_ID]: {
    name: "Associated Token Account",
    category: "token",
  },
  [COMPUTE_BUDGET_PROGRAM_ID]: { name: "Compute Budget", category: "infra" },
  [MEMO_PROGRAM_ID]: { name: "Memo", category: "infra" },
  [MEMO_V1_PROGRAM_ID]: { name: "Memo (v1)", category: "infra" },
  [BPF_LOADER_UPGRADEABLE_ID]: {
    name: "BPF Loader (Upgradeable)",
    category: "infra",
  },
  BPFLoader2111111111111111111111111111111111: {
    name: "BPF Loader 2",
    category: "infra",
  },
  Stake11111111111111111111111111111111111111: {
    name: "Stake Program",
    category: "system",
  },
  Vote111111111111111111111111111111111111111: {
    name: "Vote Program",
    category: "governance",
  },
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: {
    name: "Metaplex Token Metadata",
    category: "nft",
  },
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: {
    name: "Jupiter Aggregator v6",
    category: "defi",
  },
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
    name: "Raydium Liquidity Pool v4",
    category: "defi",
  },
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: {
    name: "Orca Whirlpools",
    category: "defi",
  },
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": {
    name: "pump.fun",
    category: "defi",
  },
};

export function resolveProgram(programId: string): KnownProgram | undefined {
  return KNOWN_PROGRAMS[programId];
}

export function isKnownProgram(programId: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_PROGRAMS, programId);
}
