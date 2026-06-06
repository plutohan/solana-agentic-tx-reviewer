/**
 * Circuit breaker: turn a RiskReport into a signing decision.
 *
 * The deterministic review is the classifier; this is the policy layer on top.
 * The load-bearing axis is IRREVERSIBILITY ("blast radius"): an autonomous agent
 * can proceed on routine, reversible activity, but anything that hands over
 * control or moves value irreversibly should require a human signature.
 *
 *   ALLOW         - routine; an agent MAY sign autonomously. The ONLY auto-signable tier.
 *   WARN          - flagged but not classified irreversible. NOT auto-signable; an agent
 *                   must escalate for human or secondary review before signing.
 *   REQUIRE_HUMAN - irreversible blast radius (or high overall risk, or a report we cannot
 *                   parse). A human must sign.
 *
 * Gate on `decision.autoSignable` (true only for ALLOW). Both WARN and REQUIRE_HUMAN
 * block autonomous signing. The breaker fails CLOSED: anything it cannot reason about
 * (an unknown program, a malformed report, an invalid option) escalates, never ALLOWs.
 *
 * Pure function. No network, no keys, no side effects. "Circuit breaker, not vibes."
 */
import type { RiskReport, RiskFinding, RiskLevel } from "./types.js";

export type SignDecision = "ALLOW" | "WARN" | "REQUIRE_HUMAN";

/**
 * Finding ids whose underlying action is IRREVERSIBLE or hands an attacker lasting
 * control, OR which the engine cannot reason about (an opaque unknown program, whose
 * custom instruction layout could do anything). These gate to a human signature.
 *
 * UNKNOWN_PROGRAM is included on purpose: every drain/authority/delegate rule keys on a
 * decoded instruction type, so a novel program that moves value through its own encoding
 * produces NO specific finding. The unrecognized-program signal is then the only thing
 * that fires, and an autonomous signer must not auto-approve what it cannot inspect.
 */
export const IRREVERSIBLE_FINDINGS = new Set<string>([
  "SET_AUTHORITY",
  "ACCOUNT_REASSIGN",
  "TOKEN_DELEGATE_APPROVE",
  "FULL_TOKEN_ACCOUNT_DRAIN",
  "LARGE_TOKEN_OUTFLOW",
  "LARGE_SOL_OUTFLOW",
  "TOKEN_BURN",
  "TOKEN_FREEZE",
  "PROGRAM_DEPLOY_OR_UPGRADE",
  "FLAGGED_ADDRESS",
  "UNKNOWN_PROGRAM",
]);

export interface CircuitBreakerOptions {
  /** Overall level at/above which to REQUIRE_HUMAN even without an irreversible finding. Default "high". */
  requireHumanAtLevel?: RiskLevel;
  /** Overall level at/above which to WARN. Default "medium". */
  warnAtLevel?: RiskLevel;
  /** Override the set of finding ids treated as irreversible. */
  irreversibleFindings?: Set<string>;
}

export interface CircuitBreakerDecision {
  action: SignDecision;
  /** True ONLY for ALLOW. Gate autonomous signing on this; WARN and REQUIRE_HUMAN both block. */
  autoSignable: boolean;
  /** Human-readable reasons for the decision. */
  reasons: string[];
  /** The specific findings responsible for a non-ALLOW outcome, on every branch. */
  gatedBy: RiskFinding[];
  /** The subset of gatedBy classified as irreversible (blast radius). */
  irreversible: RiskFinding[];
}

const RANK: Record<RiskLevel, number> = { info: 0, low: 1, medium: 2, high: 3 };

function build(
  action: SignDecision,
  reasons: string[],
  gatedBy: RiskFinding[],
  irreversible: RiskFinding[],
): CircuitBreakerDecision {
  return { action, autoSignable: action === "ALLOW", reasons, gatedBy, irreversible };
}

/**
 * Decide whether a transaction is safe for an agent to sign autonomously.
 * Anything with irreversible blast radius (or high overall risk, or an unparseable
 * report) gates to a human. Fails closed.
 */
export function decide(
  report: RiskReport,
  options: CircuitBreakerOptions = {},
): CircuitBreakerDecision {
  const irreversibleSet = options.irreversibleFindings ?? IRREVERSIBLE_FINDINGS;
  // Coerce invalid option levels toward the safe end rather than to undefined (which would
  // make every comparison false and collapse the breaker to ALLOW).
  const requireAt = RANK[options.requireHumanAtLevel ?? "high"] ?? RANK.high;
  const warnAt = RANK[options.warnAtLevel ?? "medium"] ?? RANK.medium;

  // Defensive: a malformed report should fail closed, not open.
  if (!report || !Array.isArray(report.findings)) {
    return build("REQUIRE_HUMAN", ["Malformed risk report; failing closed to a human signature."], [], []);
  }

  const irreversible = report.findings.filter(
    (f) => f.level !== "info" && irreversibleSet.has(f.id),
  );
  if (irreversible.length > 0) {
    return build(
      "REQUIRE_HUMAN",
      ["Irreversible or opaque action with lasting blast radius; a human signature is required.", ...irreversible.map((f) => `${f.id}: ${f.title}`)],
      irreversible,
      irreversible,
    );
  }

  const rank = RANK[report.level];
  if (rank === undefined) {
    // Unrecognized overall level => fail closed.
    return build("REQUIRE_HUMAN", [`Unrecognized risk level "${String(report.level)}"; failing closed to a human signature.`], [], []);
  }

  if (rank >= requireAt) {
    const gatedBy = report.findings.filter((f) => (RANK[f.level] ?? 0) >= requireAt);
    return build("REQUIRE_HUMAN", [`Overall risk is ${report.level}; a human signature is required.`], gatedBy, []);
  }

  if (rank >= warnAt) {
    const gatedBy = report.findings.filter((f) => (RANK[f.level] ?? 0) >= warnAt);
    return build("WARN", [`Do not auto-sign: ${report.level} risk needs human or secondary review.`, report.summary], gatedBy, []);
  }

  return build("ALLOW", ["No irreversible actions and no medium or high risk signals."], [], []);
}
