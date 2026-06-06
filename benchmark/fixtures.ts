/**
 * Labeled benchmark corpus for the deterministic risk engine.
 *
 * Each fixture is a hand-built ParsedTransaction with a ground-truth label
 * (benign | risky) and `engineFlags` = what assessRisk currently outputs
 * (a finding of level medium or high). Two fixtures are deliberate FP/FN probes
 * so the reported precision/recall is honest, not a self-graded 100%.
 *
 * This is a SYNTHETIC seed corpus (no network). The next step is capturing real
 * on-chain transactions into the same shape; the runner and metrics are built to
 * grow with that.
 */
import {
  resolveProgram,
  type ParsedTransaction,
  type InstructionSummary,
  type TokenBalanceChange,
  type AccountSummary,
  type ProgramInvocation,
} from "@solana-tx-reviewer/core";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const CB = "ComputeBudget111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const BURN = "1nc1nerator11111111111111111111111111111111";
const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcozatg"; // legit, but not in our registry
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const JUNK = "JUNKmint1111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const SIGNER = "S1gnerWa11et1111111111111111111111111111111";
const ATTACKER = "Attacker11111111111111111111111111111111111";

export interface Fixture {
  name: string;
  truth: "benign" | "risky";
  /** What assessRisk currently outputs (level medium|high). Regression guard. */
  engineFlags: boolean;
  note?: string;
  tx: ParsedTransaction;
}

function acct(pubkey: string, opts: Partial<AccountSummary> = {}): AccountSummary {
  return { index: 0, pubkey, signer: false, writable: false, isProgram: false, solChangeLamports: 0, solChangeSol: 0, ...opts };
}
function ix(programId: string, opts: Partial<InstructionSummary> = {}): InstructionSummary {
  return { index: 0, programId, programName: resolveProgram(programId)?.name, accounts: [], isInner: false, ...opts };
}
function tok(owner: string, mint: string, decimals: number, pre: number, post: number): TokenBalanceChange {
  const uiPreAmount = pre / 10 ** decimals;
  const uiPostAmount = post / 10 ** decimals;
  return {
    accountIndex: 0, account: `${owner.slice(0, 6)}-ata`, owner, mint, decimals,
    preAmount: String(pre), postAmount: String(post), uiPreAmount, uiPostAmount, delta: uiPostAmount - uiPreAmount,
  };
}

function mk(
  name: string,
  truth: "benign" | "risky",
  engineFlags: boolean,
  p: {
    accounts?: AccountSummary[];
    instructions?: InstructionSummary[];
    tokenBalanceChanges?: TokenBalanceChange[];
    feePayer?: string;
    feeSol?: number;
    success?: boolean;
    note?: string;
  },
): Fixture {
  const accounts = (p.accounts ?? []).map((a, i) => ({ ...a, index: i }));
  const instructions = (p.instructions ?? []).map((x, i) => ({ ...x, index: i }));
  const signers = accounts.filter((a) => a.signer).map((a) => a.pubkey);
  const writableAccounts = accounts.filter((a) => a.writable).map((a) => a.pubkey);
  const counts = new Map<string, number>();
  for (const i of instructions) counts.set(i.programId, (counts.get(i.programId) ?? 0) + 1);
  const programsInvoked: ProgramInvocation[] = [...counts].map(([programId, count]) => ({
    programId, name: resolveProgram(programId)?.name, count,
  }));
  const feeSol = p.feeSol ?? 0.000005;
  const feePayer = p.feePayer ?? signers[0] ?? accounts[0]?.pubkey ?? "";
  const tx: ParsedTransaction = {
    signature: name, cluster: "mainnet-beta", slot: 0, blockTime: null,
    success: p.success ?? true, err: p.success === false ? "InstructionError" : null,
    feeLamports: Math.round(feeSol * 1e9), feeSol, recentBlockhash: "", feePayer,
    accounts, signers, writableAccounts, instructions, logMessages: [],
    tokenBalanceChanges: p.tokenBalanceChanges ?? [], programsInvoked, version: "legacy",
  };
  return { name, truth, engineFlags, note: p.note, tx };
}

const signer = (extra: Partial<AccountSummary> = {}) => acct(SIGNER, { signer: true, writable: true, ...extra });

export const FIXTURES: Fixture[] = [
  // ---- benign (engine should NOT flag) ----
  mk("small-sol-transfer", "benign", false, {
    accounts: [signer({ solChangeLamports: -10_000_000, solChangeSol: -0.01 }), acct("Friend11111111111111111111111111111111111")],
    instructions: [ix(SYSTEM, { program: "system", parsedType: "transfer" })],
  }),
  mk("jupiter-swap", "benign", false, {
    accounts: [signer()],
    instructions: [ix(JUP), ix(TOKEN, { program: "spl-token", parsedType: "transfer" })],
    tokenBalanceChanges: [tok(SIGNER, USDC, 6, 1000_000000, 0), tok(SIGNER, BONK, 5, 0, 50_000000)],
    note: "swap-aware relabel: full USDC outflow + BONK received back via a DEX -> TOKEN_SWAP (low)",
  }),
  mk("compute-budget-and-memo", "benign", false, {
    accounts: [signer()],
    instructions: [ix(CB, { program: "compute-budget", parsedType: "setComputeUnitLimit" }), ix(MEMO, { program: "spl-memo", parsedType: "memo" })],
  }),
  mk("ata-create-and-transfer", "benign", false, {
    accounts: [signer()],
    instructions: [ix(SYSTEM, { program: "system", parsedType: "createAccount" }), ix(TOKEN, { program: "spl-token", parsedType: "transfer" })],
  }),
  mk("partial-outflow-40pct", "benign", false, {
    accounts: [signer()],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "transfer" })],
    tokenBalanceChanges: [tok(SIGNER, USDC, 6, 1000_000000, 600_000000)],
    note: "40% outflow is below the 50% LARGE_TOKEN_OUTFLOW threshold",
  }),
  mk("wsol-outflow-excluded", "benign", false, {
    accounts: [signer({ solChangeLamports: 990_000_000, solChangeSol: 0.99 })],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "transfer" })],
    tokenBalanceChanges: [tok(SIGNER, WSOL, 9, 1_000_000_000, 0)],
    note: "wrapped SOL is excluded from the token drain rules (it is transient wrap/unwrap)",
  }),

  // ---- risky (engine should flag) ----
  mk("full-token-drain", "risky", true, {
    accounts: [signer()],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "transfer" })],
    tokenBalanceChanges: [tok(SIGNER, USDC, 6, 1000_000000, 0)],
    note: "signer-owned token account zeroed, no DEX -> FULL_TOKEN_ACCOUNT_DRAIN (high)",
  }),
  mk("set-authority-handover", "risky", true, {
    accounts: [signer()],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "setAuthority", info: { newAuthority: ATTACKER, authorityType: "AccountOwner" } })],
  }),
  mk("delegate-approve", "risky", true, {
    accounts: [signer()],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "approve", info: { delegate: ATTACKER, amount: "1000000000000" } })],
  }),
  mk("transfer-to-burn-address", "risky", true, {
    accounts: [signer({ solChangeLamports: -500_000_000, solChangeSol: -0.5 }), acct(BURN, { writable: true })],
    instructions: [ix(SYSTEM, { program: "system", parsedType: "transfer" })],
    note: "destination is the watchlisted burn address -> FLAGGED_ADDRESS",
  }),
  mk("large-sol-outflow-15", "risky", true, {
    accounts: [signer({ solChangeLamports: -15_000_000_000, solChangeSol: -15 }), acct(ATTACKER, { writable: true })],
    instructions: [ix(SYSTEM, { program: "system", parsedType: "transfer" })],
  }),
  mk("account-reassign", "risky", true, {
    accounts: [signer()],
    instructions: [ix(SYSTEM, { program: "system", parsedType: "assign", info: { owner: ATTACKER } })],
  }),
  mk("large-token-outflow-95pct", "risky", true, {
    accounts: [signer()],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "transfer" })],
    tokenBalanceChanges: [tok(SIGNER, USDC, 6, 1000_000000, 50_000000)],
    note: "95% outflow (>=90%) -> LARGE_TOKEN_OUTFLOW (medium)",
  }),
  mk("close-token-account-cleanup", "benign", true, {
    accounts: [signer()],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "closeAccount" })],
    note: "FALSE POSITIVE: a standalone closeAccount (rent reclaim / cleanup) is usually benign, but CLOSE_TOKEN_ACCOUNT flags every close as medium. It should require additional drain signals.",
  }),
  mk("stacked-drainer", "risky", true, {
    accounts: [signer()],
    instructions: [
      ix(TOKEN, { program: "spl-token", parsedType: "approve", info: { delegate: ATTACKER, amount: "1000000000000" } }),
      ix(TOKEN, { program: "spl-token", parsedType: "setAuthority", info: { newAuthority: ATTACKER, authorityType: "AccountOwner" } }),
      ix(TOKEN, { program: "spl-token", parsedType: "transfer" }),
    ],
    tokenBalanceChanges: [tok(SIGNER, USDC, 6, 1000_000000, 0)],
    note: "multi-step approve + setAuthority + full drain",
  }),
  mk("token-burn", "risky", true, {
    accounts: [signer()],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "burn", info: { account: "SigAta", amount: "1000000000" } })],
    note: "burns tokens permanently -> TOKEN_BURN (high, irreversible)",
  }),
  mk("token-freeze", "risky", true, {
    accounts: [signer()],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "freezeAccount", info: { account: "SigAta" } })],
    note: "freezes a token account -> TOKEN_FREEZE (high, irreversible)",
  }),
  mk("owner-reassign-with-seed", "risky", true, {
    accounts: [signer()],
    instructions: [ix(SYSTEM, { program: "system", parsedType: "assignWithSeed", info: { owner: ATTACKER } })],
    note: "owner reassignment via assignWithSeed (the variant the old rule missed) -> ACCOUNT_REASSIGN",
  }),
  mk("unlimited-delegate-approval", "risky", true, {
    accounts: [signer()],
    instructions: [ix(TOKEN, { program: "spl-token", parsedType: "approve", info: { delegate: ATTACKER, amount: "18446744073709551615" } })],
    note: "approve for u64-max (unlimited) -> TOKEN_DELEGATE_APPROVE escalated to high",
  }),
  mk("nonce-authority-change", "risky", true, {
    accounts: [signer()],
    instructions: [ix(SYSTEM, { program: "system", parsedType: "authorizeNonce", info: { newAuthority: ATTACKER } })],
    note: "hands a durable-nonce account to a new authority -> NONCE_AUTHORITY_CHANGE (high)",
  }),
  mk("program-impersonation", "risky", true, {
    accounts: [signer()],
    instructions: [ix("JUP6LkbXfake1111111111111111111111111111111")],
    note: "program address mimics Jupiter v6's 7-char prefix -> PROGRAM_IMPERSONATION (high)",
  }),
  mk("cosigner-sol-drain", "risky", true, {
    accounts: [
      acct(SIGNER, { signer: true, writable: true }),
      acct("Cos1gnerWa11et11111111111111111111111111111", { signer: true, writable: true, solChangeLamports: -11_000_000_000, solChangeSol: -11 }),
    ],
    instructions: [ix(SYSTEM, { program: "system", parsedType: "transfer" })],
    note: "a co-signer (not the fee payer) loses 11 SOL -> LARGE_SOL_OUTFLOW must fire on a non-fee-payer signer",
  }),
  mk("durable-nonce", "benign", false, {
    accounts: [signer()],
    instructions: [
      ix(SYSTEM, { program: "system", parsedType: "advanceNonce" }),
      ix(SYSTEM, { program: "system", parsedType: "transfer" }),
    ],
    note: "a durable nonce ALONE is a timing property (legit multisig/custody use it); flagged only at low, never auto-blocked",
  }),
  mk("benign-account-init", "benign", false, {
    accounts: [signer()],
    instructions: [
      ix(SYSTEM, { program: "system", parsedType: "createAccount" }),
      ix(SYSTEM, { program: "system", parsedType: "assign", info: { account: "NewPda1111111111111111111111111111111111111", owner: TOKEN } }),
    ],
    note: "assigning a fresh non-signer account to a KNOWN program is routine init; ACCOUNT_REASSIGN must NOT fire",
  }),

  // ---- honest probes (these are WHY precision/recall is not 100%) ----
  mk("legit-unknown-program", "benign", true, {
    accounts: [signer()],
    instructions: [ix(DRIFT)],
    note: "FALSE POSITIVE: a legitimate protocol not in our small registry trips UNKNOWN_PROGRAM (medium). 'Unknown' is not 'malicious'.",
  }),
  mk("dust-relabel-evasion", "risky", false, {
    accounts: [signer()],
    instructions: [ix(JUP), ix(TOKEN, { program: "spl-token", parsedType: "transfer" })],
    tokenBalanceChanges: [tok(SIGNER, USDC, 6, 1000_000000, 0), tok(SIGNER, JUNK, 0, 0, 2)],
    note: "FALSE NEGATIVE: a real drain sends 2 base units of a junk token back through a DEX, passing the weak >1-base-unit inflow guard, so it relabels to TOKEN_SWAP (low). The dust threshold should be value-based, not 1 base unit.",
  }),
];
