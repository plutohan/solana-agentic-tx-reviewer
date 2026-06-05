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

// Unknown program -> no decode.
const unknown = decodeIxType("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", Buffer.from([0]));
check("unknown program -> no program/type", unknown.program === undefined && unknown.parsedType === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
