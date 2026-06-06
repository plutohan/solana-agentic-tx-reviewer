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
} from "./types.js";
import { isDexProgram, isKnownProgram, WSOL_MINT } from "./programs.js";
import { lookupWatch } from "./watchlist.js";
import { formatSol, formatTokenAmount, shortPubkey } from "./format.js";

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

const DUST_LAMPORTS = 1_000_000; // 0.001 SOL — below this, an inflow is "dust"

/**
 * Swap context: did a known DEX run, and which owners received non-dust value
 * back in this tx (a token inflow > 1 base unit, including WSOL, or net SOL in)?
 * Used to distinguish a swap/position-exit from a drain.
 */
function buildSwapContext(tx: ParsedTransaction): {
  dexPresent: boolean;
  inflowOwners: Set<string>;
} {
  const dexPresent = tx.programsInvoked.some((p) => isDexProgram(p.programId));
  const inflowOwners = new Set<string>();
  for (const c of tx.tokenBalanceChanges) {
    if (c.owner && BigInt(c.postAmount) - BigInt(c.preAmount) > 1n) {
      inflowOwners.add(c.owner);
    }
  }
  for (const a of tx.accounts) {
    if (a.solChangeLamports > DUST_LAMPORTS) inflowOwners.add(a.pubkey);
  }
  return { dexPresent, inflowOwners };
}

function checkTokenMovements(tx: ParsedTransaction): RiskFinding[] {
  const findings: RiskFinding[] = [];
  const { dexPresent, inflowOwners } = buildSwapContext(tx);
  const signers = new Set(tx.signers);

  for (const c of tx.tokenBalanceChanges) {
    // Wrapped SOL is transient (wrap/unwrap); the native SOL rules cover it.
    if (c.mint === WSOL_MINT) continue;
    // Only the signing user's OWN token accounts matter for drain/outflow.
    // Pool/vault accounts (owned by program PDAs) routinely zero out in swaps.
    if (!c.owner || !signers.has(c.owner)) continue;

    const fullDrain = c.uiPreAmount > 0 && c.uiPostAmount === 0;
    const pct = c.uiPreAmount > 0 ? Math.abs(c.delta) / c.uiPreAmount : 0;
    const largeOutflow =
      c.delta < 0 && c.uiPreAmount > 0 && pct >= THRESHOLDS.largeTokenOutflowPct;
    if (!fullDrain && !largeOutflow) continue;

    const who = shortPubkey(c.owner ?? c.account);
    const mint = shortPubkey(c.mint);

    // Defensive swap-aware downgrade: relabel (don't clear) when the SAME owner
    // received non-dust value back through a known DEX in the same tx. A drainer
    // that dusts a fake inflow still fails the >1-base-unit guard, and an unknown
    // owner never qualifies (fails safe to the higher-risk drain finding).
    if (dexPresent && c.owner && inflowOwners.has(c.owner)) {
      findings.push({
        id: "TOKEN_SWAP",
        title: "Token swapped via a DEX",
        level: "low",
        detail:
          "This account sent most/all of a token balance, but the same owner received value back through a known DEX/aggregator in the same transaction — consistent with a swap or position exit, not a drain. Still verify the amounts and counterparty.",
        evidence: [
          `${who} swapped ${formatTokenAmount(Math.abs(c.delta), c.decimals)} of mint ${mint} via a known DEX`,
        ],
      });
      continue;
    }

    if (fullDrain) {
      findings.push({
        id: "FULL_TOKEN_ACCOUNT_DRAIN",
        title: "Token account fully drained",
        level: "high",
        detail:
          "A token account went from a positive balance to zero — the signature pattern of a wallet drain or a full position exit. Verify this was intentional.",
        evidence: [`${who} sent its entire balance of mint ${mint}`],
      });
    } else {
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
  return findings;
}

function checkWatchlist(tx: ParsedTransaction): RiskFinding[] {
  const findings: RiskFinding[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...tx.accounts.map((a) => a.pubkey),
    ...tx.programsInvoked.map((p) => p.programId),
  ];
  for (const addr of candidates) {
    if (seen.has(addr)) continue;
    seen.add(addr);
    const hit = lookupWatch(addr);
    if (!hit) continue;
    findings.push({
      id: "FLAGGED_ADDRESS",
      title: `Flagged address: ${hit.label}`,
      level: hit.category === "burn" ? "medium" : "high",
      detail:
        "An address in this transaction matches a curated watchlist of flagged addresses/programs. The list is best-effort and non-exhaustive — not financial advice. Verify independently.",
      evidence: [
        `${shortPubkey(addr)} — ${hit.category}: ${hit.label} (source: ${hit.source})`,
      ],
    });
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
    if (
      ix.program === "system" &&
      (ix.parsedType === "assign" || ix.parsedType === "assignWithSeed")
    ) {
      findings.push({
        id: "ACCOUNT_REASSIGN",
        title: "Reassigns account ownership (System Assign)",
        level: "high",
        detail:
          "A System Assign changes which program owns an account. Reassigning the owner of your own account to an attacker program is a top wallet-drain vector, and it often shows no balance change in a simulation. Verify this is expected.",
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
      const unlimited = amount === "18446744073709551615"; // u64 max
      findings.push({
        id: "TOKEN_DELEGATE_APPROVE",
        title: unlimited
          ? "Approves an UNLIMITED token delegate"
          : "Approves a token delegate",
        level: unlimited ? "high" : "medium",
        detail:
          "An Approve grants another address the right to move tokens from this account" +
          (unlimited
            ? " for an unlimited amount (u64 max), a hallmark of drainer approvals."
            : ". Malicious dApps abuse delegate approvals to drain tokens later.") +
          " Confirm the delegate and amount.",
        evidence: [
          `Delegate ${shortPubkey(delegate)} approved for ${unlimited ? "an UNLIMITED amount (u64 max)" : amount}`,
        ],
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

function checkDestructiveTokenOps(tx: ParsedTransaction): RiskFinding[] {
  const findings: RiskFinding[] = [];
  for (const ix of tx.instructions) {
    if (!isToken(ix)) continue;
    if (ix.parsedType === "burn" || ix.parsedType === "burnChecked") {
      findings.push({
        id: "TOKEN_BURN",
        title: "Burns tokens (irreversible)",
        level: "high",
        detail:
          "A Burn permanently destroys tokens from a token account. This cannot be undone. Confirm the mint and amount are intended.",
        evidence: [`Burns from ${shortPubkey(str(ix.info?.account))}`],
      });
    }
    if (ix.parsedType === "freezeAccount") {
      findings.push({
        id: "TOKEN_FREEZE",
        title: "Freezes a token account",
        level: "high",
        detail:
          "A FreezeAccount locks a token account so its owner can no longer move funds until a freeze authority thaws it. From the holder's side this is an irreversible loss of access.",
        evidence: [`Freezes ${shortPubkey(str(ix.info?.account))}`],
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

function checkDurableNonce(tx: ParsedTransaction): RiskFinding | null {
  const has = tx.instructions.some(
    (ix) => ix.program === "system" && ix.parsedType === "advanceNonce",
  );
  if (!has) return null;
  return {
    id: "DURABLE_NONCE_PRESENT",
    title: "Uses a durable nonce (delayed execution)",
    level: "medium",
    detail:
      "An AdvanceNonceAccount makes this transaction valid indefinitely instead of for the usual ~2 minutes. A signed durable-nonce transaction can be held and submitted later, when conditions favor an attacker. Verify why a durable nonce is needed.",
  };
}

const RULES: Array<(tx: ParsedTransaction) => RiskFinding | RiskFinding[] | null> =
  [
    checkFailed,
    checkWatchlist,
    checkUnknownPrograms,
    checkFeePayerSolOutflow,
    checkTokenMovements,
    checkAuthorityChanges,
    checkDelegations,
    checkCloseAccounts,
    checkDestructiveTokenOps,
    checkProgramDeploy,
    checkManyWritable,
    checkHighFee,
    checkAccountCreation,
    checkMultipleSigners,
    checkComputeBudget,
    checkMemo,
    checkDurableNonce,
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

/** Collapse repeated same-id findings into one (merging evidence, tagging count). */
function dedupeFindings(raw: RiskFinding[]): RiskFinding[] {
  const map = new Map<string, { finding: RiskFinding; count: number }>();
  for (const f of raw) {
    const entry = map.get(f.id);
    if (!entry) {
      map.set(f.id, {
        finding: { ...f, evidence: f.evidence ? [...f.evidence] : undefined },
        count: 1,
      });
    } else {
      entry.count += 1;
      if (f.evidence?.length) {
        entry.finding.evidence = [...(entry.finding.evidence ?? []), ...f.evidence];
      }
    }
  }
  return [...map.values()].map(({ finding, count }) =>
    count > 1 ? { ...finding, title: `${finding.title} (×${count})` } : finding,
  );
}

/**
 * Score with diminishing returns per level (the k-th finding at a level adds
 * weight * 0.5^k). Prevents saturation at 100 for busy-but-benign transactions
 * while keeping real, stacked high-severity signals near the top.
 */
function computeScore(findings: RiskFinding[]): number {
  const indexByLevel: Record<RiskLevel, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
  };
  const ordered = [...findings].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  let total = 0;
  for (const f of ordered) {
    const k = indexByLevel[f.level]++;
    total += LEVEL_WEIGHT[f.level] * Math.pow(0.5, k);
  }
  return clamp(Math.round(total), 0, 100);
}

export function assessRisk(tx: ParsedTransaction): RiskReport {
  const raw: RiskFinding[] = [];
  for (const rule of RULES) {
    const result = rule(tx);
    if (!result) continue;
    if (Array.isArray(result)) raw.push(...result);
    else raw.push(result);
  }

  const findings = dedupeFindings(raw);
  findings.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  const score = computeScore(findings);
  const level = overallLevel(findings);

  return { score, level, findings, summary: buildSummary(findings, level) };
}
