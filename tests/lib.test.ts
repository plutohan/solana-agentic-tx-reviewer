/**
 * Unit tests for pure helpers (no RPC). Run via `npm test`.
 * Covers the base-unit -> UI conversion and the pre-sign instruction decoder.
 */
import { rawToUi } from "../src/lib/parse";
import { decodeIxType } from "../src/lib/presign";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from "../src/lib/programs";
import { checkRateLimit } from "../src/lib/ratelimit";
import { decide } from "@solana-tx-reviewer/core";
import type { RiskReport, RiskFinding } from "@solana-tx-reviewer/core";

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

// rawToUi: integer base units -> decimal-adjusted UI amount.
check("rawToUi 1500000 @6 = 1.5", rawToUi("1500000", 6) === 1.5);
check("rawToUi 0 @9 = 0", rawToUi("0", 9) === 0);
check("rawToUi 1000000000 @9 = 1", rawToUi("1000000000", 9) === 1);
check("rawToUi negative", rawToUi("-2500000", 6) === -2.5);
check("rawToUi 0 decimals = identity", rawToUi("42", 0) === 42);

// decodeIxType: SPL Token (single-byte discriminator).
const tok = (b: number) => decodeIxType(TOKEN_PROGRAM_ID, Buffer.from([b]));
check("token 3 -> transfer (spl-token)", tok(3).parsedType === "transfer" && tok(3).program === "spl-token");
check("token 4 -> approve", tok(4).parsedType === "approve");
check("token 6 -> setAuthority", tok(6).parsedType === "setAuthority");
check("token 9 -> closeAccount", tok(9).parsedType === "closeAccount");
check(
  "token-2022 program label",
  decodeIxType(TOKEN_2022_PROGRAM_ID, Buffer.from([3])).program === "spl-token-2022",
);

// decodeIxType: System (u32 LE discriminator).
const sys = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return decodeIxType(SYSTEM_PROGRAM_ID, b);
};
check("system 0 -> createAccount (system)", sys(0).parsedType === "createAccount" && sys(0).program === "system");
check("system 1 -> assign", sys(1).parsedType === "assign");
check("system 2 -> transfer", sys(2).parsedType === "transfer");
check("system 4 -> advanceNonce", sys(4).parsedType === "advanceNonce");
check("system 5 -> withdrawFromNonce (matches RPC jsonParsed)", sys(5).parsedType === "withdrawFromNonce");
check("system 7 -> authorizeNonce (matches RPC jsonParsed)", sys(7).parsedType === "authorizeNonce");

// decodeIxType: Compute Budget, Associated Token Account, Memo (richer pre-sign labeling).
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
check(
  "compute-budget 2 -> setComputeUnitLimit",
  decodeIxType(COMPUTE_BUDGET, Buffer.from([2])).parsedType === "setComputeUnitLimit" &&
    decodeIxType(COMPUTE_BUDGET, Buffer.from([2])).program === "compute-budget",
);
check("compute-budget 3 -> setComputeUnitPrice", decodeIxType(COMPUTE_BUDGET, Buffer.from([3])).parsedType === "setComputeUnitPrice");
check(
  "ATA empty data -> create",
  decodeIxType(ATA, Buffer.from([])).parsedType === "create" &&
    decodeIxType(ATA, Buffer.from([])).program === "spl-associated-token-account",
);
check("ATA 1 -> createIdempotent", decodeIxType(ATA, Buffer.from([1])).parsedType === "createIdempotent");
check(
  "memo -> memo",
  decodeIxType(MEMO, Buffer.from("hi")).parsedType === "memo" &&
    decodeIxType(MEMO, Buffer.from("hi")).program === "spl-memo",
);

// Unknown program -> no decode.
const unknown = decodeIxType("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", Buffer.from([0]));
check("unknown program -> no program/type", unknown.program === undefined && unknown.parsedType === undefined);

// rate limiter: per-key window with a hard cap; keys are independent.
const r1 = checkRateLimit("rl-a", 3, 60_000);
check("ratelimit first call ok, remaining 2", r1.ok && r1.remaining === 2);
check("ratelimit second call remaining 1", checkRateLimit("rl-a", 3, 60_000).remaining === 1);
check("ratelimit third call remaining 0", checkRateLimit("rl-a", 3, 60_000).remaining === 0);
check("ratelimit fourth call blocked", checkRateLimit("rl-a", 3, 60_000).ok === false);
check("ratelimit other key is independent", checkRateLimit("rl-b", 3, 60_000).ok === true);

// circuit breaker: decide() keys on irreversibility, not just the score. Fails closed.
const mkReport = (level: RiskReport["level"], findings: RiskFinding[]): RiskReport => ({ score: 0, level, findings, summary: "test" });
const f = (id: string, level: RiskFinding["level"]): RiskFinding => ({ id, level, title: id, detail: "" });
check("decide: setAuthority (irreversible) -> REQUIRE_HUMAN", decide(mkReport("high", [f("SET_AUTHORITY", "high")])).action === "REQUIRE_HUMAN");
check("decide: delegate approve (irreversible) -> REQUIRE_HUMAN", decide(mkReport("medium", [f("TOKEN_DELEGATE_APPROVE", "medium")])).action === "REQUIRE_HUMAN");
check("decide: token burn (irreversible) -> REQUIRE_HUMAN", decide(mkReport("high", [f("TOKEN_BURN", "high")])).action === "REQUIRE_HUMAN");
check("decide: unknown program (opaque) -> REQUIRE_HUMAN", decide(mkReport("medium", [f("UNKNOWN_PROGRAM", "medium")])).action === "REQUIRE_HUMAN");
check("decide: closeAccount (medium, reversible) -> WARN", decide(mkReport("medium", [f("CLOSE_TOKEN_ACCOUNT", "medium")])).action === "WARN");
check("decide: token swap (low) -> ALLOW", decide(mkReport("low", [f("TOKEN_SWAP", "low")])).action === "ALLOW");
check("decide: no findings -> ALLOW", decide(mkReport("info", [])).action === "ALLOW");
check("decide: autoSignable only for ALLOW", decide(mkReport("low", [f("TOKEN_SWAP", "low")])).autoSignable === true && decide(mkReport("medium", [f("CLOSE_TOKEN_ACCOUNT", "medium")])).autoSignable === false);
check("decide: fails closed on unknown level", decide(mkReport("nonsense" as RiskReport["level"], [])).action === "REQUIRE_HUMAN");
check("decide: malformed report fails closed", decide({} as RiskReport).action === "REQUIRE_HUMAN");
check("decide: gatedBy populated on level gate", decide(mkReport("high", [f("MANY_WRITABLE_ACCOUNTS", "high")])).gatedBy.length === 1);
check("decide: surfaces irreversible findings", decide(mkReport("high", [f("FULL_TOKEN_ACCOUNT_DRAIN", "high")])).irreversible.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
