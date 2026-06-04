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

/** Native SOL wrapped as an SPL mint. Transient by design (wrap/unwrap). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

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
    name: "pump.fun (bonding curve)",
    category: "defi",
  },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: {
    name: "PumpSwap AMM",
    category: "defi",
  },
  pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ: {
    name: "pump.fun Fee",
    category: "defi",
  },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: {
    name: "Raydium CLMM",
    category: "defi",
  },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: {
    name: "Raydium CPMM",
    category: "defi",
  },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: {
    name: "Meteora DLMM",
    category: "defi",
  },
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: {
    name: "Meteora DAMM v2",
    category: "defi",
  },
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: {
    name: "Phoenix",
    category: "defi",
  },
  "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c": {
    name: "Lifinity v2",
    category: "defi",
  },
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: {
    name: "Jupiter Aggregator v4",
    category: "defi",
  },
  T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt: {
    name: "Jito Tip Payment",
    category: "infra",
  },
};

/**
 * Swap venues / aggregators. Used by the risk engine to recognize that a
 * "full token outflow" is part of a swap rather than a drain.
 */
export const DEX_PROGRAM_IDS = new Set<string>([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", // Jupiter v4
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpools
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM v2
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", // Phoenix
  "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c", // Lifinity v2
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap AMM
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun bonding curve
]);

export function isDexProgram(programId: string): boolean {
  return DEX_PROGRAM_IDS.has(programId);
}

export function resolveProgram(programId: string): KnownProgram | undefined {
  return KNOWN_PROGRAMS[programId];
}

export function isKnownProgram(programId: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_PROGRAMS, programId);
}
