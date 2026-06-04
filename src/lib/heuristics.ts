/**
 * Deterministic risk heuristics.
 *
 * Each rule is a pure function of the ParsedTransaction. Rules emit RiskFindings
 * with a level (info/low/medium/high) and human-readable evidence. The overall
 * level is the max of all findings; the numeric score is a clamped weighted sum.
 *
 * These are explainable SIGNALS, not a verdict. They are designed to surface the
 * patterns a careful reviewer would look for — drains, authority handovers,
 * delegate approvals, unknown programs — not to prove intent.
 */
import type {
  ParsedTransaction,
  InstructionSummary,
  RiskFinding,
  RiskLevel,
  RiskReport,
} from "./types";
import { isKnownProgram } from "./programs";
import { formatSol, formatTokenAmount, shortPubkey } from "./format";

/** How much each finding level contributes to the 0–100 score. */
export const LEVEL_WEIGHT: Record<RiskLevel, number> = {
  info: 0,
  low: 10,
  medium: 25,
  high: 45,
};

const LEVEL_RANK: Record<RiskLevel, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/** Tunable thresholds (documented in RISK_HEURISTICS.md). */
export const THRESHOLDS = {
  largeSolOutflow: 1, // SOL
  veryLargeSolOutflow: 10, // SOL
  manyWritableAccounts: 12,
  highFeeSol: 0.01, // SOL
  largeTokenOutflowPct: 0.5, // fraction of pre-balance
};

const TOKEN_PROGRAMS = new Set(["spl-token", "spl-token-2022"]);

function isToken(ix: InstructionSummary): boolean {
  return !!ix.program && TOKEN_PROGRAMS.has(ix.program);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

function checkFailed(tx: ParsedTransaction): RiskFinding | null {
  if (tx.success) return null;
  return {
    id: "TX_FAILED",
    title: "Transaction failed on-chain",
    level: "info",
    detail:
      "This transaction did not execute successfully, so its instructions had no lasting effect besides the fee. Failures are not directly risky, but can indicate a misconfigured or hostile interaction.",
    evidence: [`Error: ${JSON.stringify(tx.err)}`],
  };
}

function checkUnknownPrograms(tx: ParsedTransaction): RiskFinding | null {
  const unknown = tx.programsInvoked.filter((p) => !isKnownProgram(p.programId));
  if (unknown.length === 0) return null;
  return {
    id: "UNKNOWN_PROGRAM",
    title: `Interacts with ${unknown.length} unrecognized program${unknown.length > 1 ? "s" : ""}`,
    level: "medium",
    detail:
      "The transaction calls one or more programs not in our registry of well-known Solana programs. Unrecognized does not mean malicious, but you should independently verify you trust these programs.",
    evidence: unknown.map(
      (p) => `${p.programId} (${p.count} instruction${p.count > 1 ? "s" : ""})`,
    ),
  };
}

function checkFeePayerSolOutflow(tx: ParsedTransaction): RiskFinding | null {
  const feePayer = tx.accounts.find((a) => a.pubkey === tx.feePayer);
  if (!feePayer) return null;
  const outflow = -feePayer.solChangeSol; // positive == losing SOL
  if (outflow <= THRESHOLDS.largeSolOutflow) return null;
  const level: RiskLevel =
    outflow >= THRESHOLDS.veryLargeSolOutflow ? "high" : "medium";
  return {
    id: "LARGE_SOL_OUTFLOW",
    title: `Signing wallet sends ${formatSol(outflow)} SOL`,
    level,
    detail:
      "The fee payer has a large net SOL decrease. Confirm the destination and amount are expected — large outflows are common in both legitimate transfers and drains.",
    evidence: [
      `Net change for ${shortPubkey(tx.feePayer)}: -${formatSol(outflow)} SOL (includes ${formatSol(tx.feeSol)} SOL fee)`,
    ],
  };
}

function checkTokenMovements(tx: ParsedTransaction): RiskFinding[] {
  const findings: RiskFinding[] = [];
  for (const c of tx.tokenBalanceChanges) {
    const who = shortPubkey(c.owner ?? c.account);
    const mint = shortPubkey(c.mint);

    if (c.uiPreAmount > 0 && c.uiPostAmount === 0) {
      findings.push({
        id: "FULL_TOKEN_ACCOUNT_DRAIN",
        title: "Token account fully drained",
        level: "high",
        detail:
          "A token account went from a positive balance to zero — the signature pattern of a wallet drain or a full position exit. Verify this was intentional.",
        evidence: [`${who} sent its entire balance of mint ${mint}`],
      });
    } else if (c.delta < 0 && c.uiPreAmount > 0) {
      const pct = Math.abs(c.delta) / c.uiPreAmount;
      if (pct >= THRESHOLDS.largeTokenOutflowPct) {
        findings.push({
          id: "LARGE_TOKEN_OUTFLOW",
          title: `Large token outflow (${Math.round(pct * 100)}% of balance)`,
          level: pct >= 0.9 ? "medium" : "low",
          detail:
            "A token account decreased by a significant fraction of its balance.",
          evidence: [
            `${who} sent ${formatTokenAmount(Math.abs(c.delta), c.decimals)} of mint ${mint} (${Math.round(pct * 100)}% of its prior balance)`,
          ],
        });
      }
    }
  }
  return findings;
}

function checkAuthorityChanges(tx: ParsedTransaction): RiskFinding[] {
  const findings: RiskFinding[] = [];
  for (const ix of tx.instructions) {
    if (isToken(ix) && ix.parsedType === "setAuthority") {
      const newAuth = str(ix.info?.newAuthority, "a new authority");
      const authType = str(ix.info?.authorityType, "authority");
      findings.push({
        id: "SET_AUTHORITY",
        title: "Changes a token account / mint authority",
        level: "high",
        detail:
          "A SetAuthority instruction transfers control of a token account or mint. Handing over authority is high-impact and is a common step in account takeovers.",
        evidence: [`Sets ${authType} to ${shortPubkey(newAuth)}`],
      });
    }
    if (ix.program === "system" && ix.parsedType === "assign") {
      findings.push({
        id: "ACCOUNT_REASSIGN",
        title: "Reassigns account ownership (System Assign)",
        level: "medium",
        detail:
          "A System Assign changes which program owns an account. Verify this is expected for the operation you intended.",
        evidence: [`Assigns to owner ${shortPubkey(str(ix.info?.owner))}`],
      });
    }
  }
  return findings;
}

function checkDelegations(tx: ParsedTransaction): RiskFinding[] {
  const findings: RiskFinding[] = [];
  for (const ix of tx.instructions) {
    if (!isToken(ix)) continue;
    if (ix.parsedType === "approve" || ix.parsedType === "approveChecked") {
      const delegate = str(ix.info?.delegate, "a delegate");
      const amount =
        str(ix.info?.amount) ||
        str((ix.info?.tokenAmount as Record<string, unknown> | undefined)?.amount) ||
        "an amount";
      findings.push({
        id: "TOKEN_DELEGATE_APPROVE",
        title: "Approves a token delegate",
        level: "medium",
        detail:
          "An Approve grants another address the right to move tokens from this account. Malicious dApps abuse delegate approvals to drain tokens later. Confirm the delegate and amount.",
        evidence: [`Delegate ${shortPubkey(delegate)} approved for ${amount}`],
      });
    }
  }
  return findings;
}

function checkCloseAccounts(tx: ParsedTransaction): RiskFinding[] {
  const findings: RiskFinding[] = [];
  for (const ix of tx.instructions) {
    if (isToken(ix) && ix.parsedType === "closeAccount") {
      findings.push({
        id: "CLOSE_TOKEN_ACCOUNT",
        title: "Closes a token account",
        level: "medium",
        detail:
          "A CloseAccount reclaims an account's rent to a destination. Benign for cleanup, but also appears as the final step of drains. Check the destination.",
        evidence: [
          `Closes ${shortPubkey(str(ix.info?.account))} → ${shortPubkey(str(ix.info?.destination))}`,
        ],
      });
    }
  }
  return findings;
}

function checkProgramDeploy(tx: ParsedTransaction): RiskFinding | null {
  const upgradeable = tx.programsInvoked.find(
    (p) => p.name === "BPF Loader (Upgradeable)",
  );
  if (!upgradeable) return null;
  return {
    id: "PROGRAM_DEPLOY_OR_UPGRADE",
    title: "Interacts with the upgradeable loader",
    level: "medium",
    detail:
      "This transaction touches the BPF Upgradeable Loader (program deploy, upgrade, or authority change). High-impact for developers; verify the target program.",
  };
}

function checkManyWritable(tx: ParsedTransaction): RiskFinding | null {
  if (tx.writableAccounts.length < THRESHOLDS.manyWritableAccounts) return null;
  return {
    id: "MANY_WRITABLE_ACCOUNTS",
    title: `${tx.writableAccounts.length} writable accounts`,
    level: "low",
    detail:
      "A large number of accounts are writable. Common for complex DeFi routes, but a broad write surface is worth a glance.",
  };
}

function checkHighFee(tx: ParsedTransaction): RiskFinding | null {
  if (tx.feeSol <= THRESHOLDS.highFeeSol) return null;
  return {
    id: "HIGH_FEE",
    title: `Elevated fee (${formatSol(tx.feeSol)} SOL)`,
    level: "low",
    detail:
      "The fee is higher than a typical base fee, usually due to priority fees. Not risky on its own, but notable.",
  };
}

function checkAccountCreation(tx: ParsedTransaction): RiskFinding | null {
  const created = tx.instructions.filter(
    (ix) =>
      ix.program === "system" &&
      (ix.parsedType === "createAccount" ||
        ix.parsedType === "createAccountWithSeed" ||
        ix.parsedType === "allocate"),
  );
  if (created.length === 0) return null;
  return {
    id: "NEW_ACCOUNT_CREATION",
    title: `Creates ${created.length} new account${created.length > 1 ? "s" : ""}`,
    level: "info",
    detail:
      "New accounts are created (e.g. token accounts or program state). Normal for first-time interactions.",
  };
}

function checkMultipleSigners(tx: ParsedTransaction): RiskFinding | null {
  if (tx.signers.length <= 1) return null;
  return {
    id: "MULTIPLE_SIGNERS",
    title: `${tx.signers.length} signers`,
    level: "info",
    detail:
      "More than one account signed this transaction. Expected for multisig or co-signed flows; unexpected co-signers are worth checking.",
  };
}

function checkComputeBudget(tx: ParsedTransaction): RiskFinding | null {
  const has = tx.programsInvoked.some((p) => p.name === "Compute Budget");
  if (!has) return null;
  return {
    id: "COMPUTE_BUDGET_SET",
    title: "Sets a compute budget",
    level: "info",
    detail:
      "Compute Budget instructions set compute-unit limits/prices (priority fees). Routine for modern transactions.",
  };
}

function checkMemo(tx: ParsedTransaction): RiskFinding | null {
  const has = tx.programsInvoked.some(
    (p) => p.name === "Memo" || p.name === "Memo (v1)",
  );
  if (!has) return null;
  return {
    id: "MEMO_PRESENT",
    title: "Attaches a memo",
    level: "info",
    detail:
      "A Memo instruction attaches a note to the transaction. Often used by exchanges/CEX deposits.",
  };
}

const RULES: Array<(tx: ParsedTransaction) => RiskFinding | RiskFinding[] | null> =
  [
    checkFailed,
    checkUnknownPrograms,
    checkFeePayerSolOutflow,
    checkTokenMovements,
    checkAuthorityChanges,
    checkDelegations,
    checkCloseAccounts,
    checkProgramDeploy,
    checkManyWritable,
    checkHighFee,
    checkAccountCreation,
    checkMultipleSigners,
    checkComputeBudget,
    checkMemo,
  ];

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function overallLevel(findings: RiskFinding[]): RiskLevel {
  let level: RiskLevel = "info";
  for (const f of findings) {
    if (LEVEL_RANK[f.level] > LEVEL_RANK[level]) level = f.level;
  }
  return level;
}

function buildSummary(findings: RiskFinding[], level: RiskLevel): string {
  if (findings.length === 0) {
    return "No notable risk signals were detected by the deterministic heuristics.";
  }
  const counts: Record<RiskLevel, number> = { info: 0, low: 0, medium: 0, high: 0 };
  for (const f of findings) counts[f.level]++;
  const parts = (["high", "medium", "low", "info"] as RiskLevel[])
    .filter((l) => counts[l] > 0)
    .map((l) => `${counts[l]} ${l}`);
  return `Overall ${level.toUpperCase()} — ${parts.join(", ")} signal${findings.length > 1 ? "s" : ""}.`;
}

export function assessRisk(tx: ParsedTransaction): RiskReport {
  const findings: RiskFinding[] = [];
  for (const rule of RULES) {
    const result = rule(tx);
    if (!result) continue;
    if (Array.isArray(result)) findings.push(...result);
    else findings.push(result);
  }

  const score = clamp(
    findings.reduce((sum, f) => sum + LEVEL_WEIGHT[f.level], 0),
    0,
    100,
  );
  const level = overallLevel(findings);
  findings.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);

  return { score, level, findings, summary: buildSummary(findings, level) };
}
