/**
 * Shared data model for the Solana Agentic Transaction Reviewer.
 *
 * The pipeline is: RPC fetch -> parse() -> assessRisk() -> explainTransaction().
 * Every module below speaks in terms of these types, so the UI, the API, the
 * risk engine, and the (future) LLM all share one contract.
 */

export type Cluster = "mainnet-beta" | "devnet" | "testnet";

/** What the client sends to /api/review. Provide exactly one of signature | rawTransaction. */
export interface ReviewRequest {
  /** A confirmed transaction signature to review (post-hoc path). */
  signature?: string;
  /** A base64-serialized UNSIGNED transaction to simulate and review (pre-sign path). */
  rawTransaction?: string;
  cluster?: Cluster;
  /** Optional custom RPC endpoint (e.g. a Helius/QuickNode URL) to avoid public-RPC rate limits. */
  rpcUrl?: string;
}

/** One account's role and net SOL movement within the transaction. */
export interface AccountSummary {
  index: number;
  pubkey: string;
  signer: boolean;
  writable: boolean;
  /** True if this account is invoked as a program by any instruction. */
  isProgram: boolean;
  /** Post-balance minus pre-balance, in lamports (can be negative). */
  solChangeLamports: number;
  solChangeSol: number;
}

/** A normalized instruction (top-level or inner/CPI). */
export interface InstructionSummary {
  /** Sequential index within the flattened instruction list. */
  index: number;
  programId: string;
  /** Friendly name if the program is in our registry. */
  programName?: string;
  /** Parsed program label from the RPC, e.g. "system", "spl-token". */
  program?: string;
  /** Parsed instruction type, e.g. "transfer", "approve", "setAuthority". */
  parsedType?: string;
  /** Accounts referenced by this instruction (best-effort for parsed ixs). */
  accounts: string[];
  /** Parsed `info` object from the RPC, when available (used for evidence). */
  info?: Record<string, unknown> | null;
  /** True for inner (CPI) instructions. */
  isInner: boolean;
  /** Index of the parent instruction for inner instructions. */
  parentIndex?: number;
}

/** A change in an SPL token account balance between pre and post state. */
export interface TokenBalanceChange {
  accountIndex: number;
  /** The token account pubkey. */
  account: string;
  /** The wallet that owns the token account, if reported. */
  owner?: string;
  mint: string;
  decimals: number;
  /** Token metadata, resolved after parsing when available. */
  symbol?: string;
  name?: string;
  logoURI?: string;
  /** Raw integer amounts (base units) as strings. */
  preAmount: string;
  postAmount: string;
  /** Human-readable (decimal-adjusted) amounts. */
  uiPreAmount: number;
  uiPostAmount: number;
  /** uiPostAmount - uiPreAmount. */
  delta: number;
}

/** Aggregated program invocation count across top-level + inner instructions. */
export interface ProgramInvocation {
  programId: string;
  name?: string;
  count: number;
}

/** The normalized, UI-ready view of a transaction. */
export interface ParsedTransaction {
  signature: string;
  cluster: string;
  slot: number;
  blockTime: number | null;
  success: boolean;
  err: unknown | null;
  feeLamports: number;
  feeSol: number;
  computeUnitsConsumed?: number;
  recentBlockhash: string;
  /** The fee payer / primary signer (account index 0). */
  feePayer: string;
  accounts: AccountSummary[];
  signers: string[];
  writableAccounts: string[];
  instructions: InstructionSummary[];
  logMessages: string[];
  tokenBalanceChanges: TokenBalanceChange[];
  programsInvoked: ProgramInvocation[];
  version: "legacy" | number;
  /** True when this view came from simulating an unsigned transaction (pre-sign path). */
  simulated?: boolean;
}

export type RiskLevel = "info" | "low" | "medium" | "high";

/** A single heuristic outcome. */
export interface RiskFinding {
  /** Stable identifier for the heuristic, e.g. "FULL_TOKEN_ACCOUNT_DRAIN". */
  id: string;
  title: string;
  level: RiskLevel;
  detail: string;
  /** Human-readable supporting facts. */
  evidence?: string[];
}

/** The deterministic risk report for a transaction. */
export interface RiskReport {
  /** 0-100, higher = riskier. */
  score: number;
  /** Overall level = the highest individual finding level. */
  level: RiskLevel;
  findings: RiskFinding[];
  summary: string;
}

/** The natural-language explanation (placeholder today, LLM-backed later). */
export interface AiExplanation {
  provider: "placeholder" | "openai" | "anthropic";
  model?: string;
  /** Plain-English narrative of what the transaction did. */
  summary: string;
  /** Key actions as short bullets. */
  bullets: string[];
  /** Important disclaimers. */
  caveats: string[];
  generatedAt: string;
}

/** The full result returned by reviewTransaction(). */
export interface ReviewResult {
  request: ReviewRequest;
  transaction: ParsedTransaction;
  risk: RiskReport;
  explanation: AiExplanation;
}
