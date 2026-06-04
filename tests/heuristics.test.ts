/**
 * Deterministic regression for the risk engine. Run: `npm test`.
 *
 * Proves the key behaviors that are hard to verify against live RPC:
 *  - a DEX swap / full position-sell is relabeled TOKEN_SWAP (not a drain)
 *  - a genuine drain (signer's tokens leave, no DEX) is HIGH
 *  - pool/vault accounts (non-signer owners) are ignored
 *  - wrapped SOL is excluded from token-outflow rules
 *  - the watchlist flags a known address
 *  - scoring no longer saturates on a busy-but-benign swap
 */
import { assessRisk } from "../src/lib/heuristics";
import type {
  ParsedTransaction,
  TokenBalanceChange,
  AccountSummary,
} from "../src/lib/types";

function tx(p: Partial<ParsedTransaction>): ParsedTransaction {
  return {
    signature: "test",
    cluster: "mainnet-beta",
    slot: 1,
    blockTime: 0,
    success: true,
    err: null,
    feeLamports: 5000,
    feeSol: 0.000005,
    recentBlockhash: "x",
    feePayer: p.feePayer ?? "USER",
    accounts: [],
    signers: [],
    writableAccounts: [],
    instructions: [],
    logMessages: [],
    tokenBalanceChanges: [],
    programsInvoked: [],
    version: "legacy",
    ...p,
  };
}

function acct(pubkey: string, solSol: number, signer = true): AccountSummary {
  return {
    index: 0,
    pubkey,
    signer,
    writable: true,
    isProgram: false,
    solChangeLamports: Math.round(solSol * 1e9),
    solChangeSol: solSol,
  };
}

function tbc(p: Partial<TokenBalanceChange>): TokenBalanceChange {
  return {
    accountIndex: 0,
    account: "acc",
    mint: "MINT",
    decimals: 6,
    preAmount: "0",
    postAmount: "0",
    uiPreAmount: 0,
    uiPostAmount: 0,
    delta: 0,
    ...p,
  };
}

const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL = "So11111111111111111111111111111111111111112";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗ FAIL:", name);
  }
}

// 1) Full position-sell through a DEX -> TOKEN_SWAP, not a drain, not HIGH.
const sell = tx({
  signers: ["USER"],
  feePayer: "USER",
  accounts: [acct("USER", 1.2)], // received 1.2 SOL back
  programsInvoked: [{ programId: PUMPSWAP, name: "PumpSwap AMM", count: 1 }],
  tokenBalanceChanges: [
    tbc({
      owner: "USER",
      mint: "MEME",
      preAmount: "1000000",
      postAmount: "0",
      uiPreAmount: 1,
      uiPostAmount: 0,
      delta: -1,
    }),
  ],
});
const r1 = assessRisk(sell);
check("sell-via-DEX => TOKEN_SWAP present", r1.findings.some((f) => f.id === "TOKEN_SWAP"));
check("sell-via-DEX => no FULL_TOKEN_ACCOUNT_DRAIN", !r1.findings.some((f) => f.id === "FULL_TOKEN_ACCOUNT_DRAIN"));
check("sell-via-DEX => not HIGH", r1.level !== "high");
check("sell-via-DEX => score not saturated (< 25)", r1.score < 25);

// 2) Genuine drain: signer's tokens leave, no DEX, no value back -> HIGH.
const drain = tx({
  signers: ["VICTIM"],
  feePayer: "VICTIM",
  accounts: [acct("VICTIM", -0.000005)],
  programsInvoked: [{ programId: SPL_TOKEN, name: "SPL Token", count: 1 }],
  tokenBalanceChanges: [
    tbc({
      owner: "VICTIM",
      mint: "USDC",
      preAmount: "1000000000",
      postAmount: "0",
      uiPreAmount: 1000,
      uiPostAmount: 0,
      delta: -1000,
    }),
  ],
});
const r2 = assessRisk(drain);
check("real-drain => FULL_TOKEN_ACCOUNT_DRAIN present", r2.findings.some((f) => f.id === "FULL_TOKEN_ACCOUNT_DRAIN"));
check("real-drain => HIGH", r2.level === "high");
check("real-drain => score >= 45", r2.score >= 45);

// 3) Pool/vault account (non-signer owner) zeroing out -> ignored.
const pool = tx({
  signers: ["USER"],
  feePayer: "USER",
  programsInvoked: [{ programId: PUMPSWAP, name: "PumpSwap AMM", count: 1 }],
  tokenBalanceChanges: [
    tbc({
      owner: "POOLVAULTPDA",
      mint: "MEME",
      preAmount: "5000000",
      postAmount: "0",
      uiPreAmount: 5,
      uiPostAmount: 0,
      delta: -5,
    }),
  ],
});
const r3 = assessRisk(pool);
check(
  "pool-vault drain (non-signer) => no token-movement finding",
  !r3.findings.some((f) =>
    ["FULL_TOKEN_ACCOUNT_DRAIN", "LARGE_TOKEN_OUTFLOW", "TOKEN_SWAP"].includes(f.id),
  ),
);

// 4) Wrapped SOL outflow by signer -> ignored (native SOL rules cover it).
const wsol = tx({
  signers: ["USER"],
  feePayer: "USER",
  tokenBalanceChanges: [
    tbc({
      owner: "USER",
      mint: WSOL,
      preAmount: "1000000000",
      postAmount: "0",
      uiPreAmount: 1,
      uiPostAmount: 0,
      delta: -1,
    }),
  ],
});
const r4 = assessRisk(wsol);
check(
  "WSOL outflow => no token-movement finding",
  !r4.findings.some((f) => ["FULL_TOKEN_ACCOUNT_DRAIN", "LARGE_TOKEN_OUTFLOW"].includes(f.id)),
);

// 5) Watchlist: a known flagged (burn) address present -> FLAGGED_ADDRESS.
const burn = tx({
  signers: ["USER"],
  feePayer: "USER",
  accounts: [acct("1nc1nerator11111111111111111111111111111111", 0, false)],
});
const r5 = assessRisk(burn);
check("watchlist burn-address => FLAGGED_ADDRESS", r5.findings.some((f) => f.id === "FLAGGED_ADDRESS"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
