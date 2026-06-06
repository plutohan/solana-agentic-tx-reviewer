/**
 * Circuit breaker: turn a RiskReport into a signing decision.
 *
 * The deterministic review is the classifier; this is the policy layer on top.
 * The load-bearing axis is IRREVERSIBILITY ("blast radius"): an autonomous agent
 * can proceed on routine, reversible activity, but anything that hands over
 * control or moves value irreversibly should require a human signature.
 *
 *   ALLOW         - routine; an agent may sign autonomously.
 *   WARN          - flagged but not irreversible; surface it, proceed with care.
 *   REQUIRE_HUMAN - irreversible blast radius (or high overall risk); a human must sign.
 *
 * Pure function. No network, no keys, no side effects. "Circuit breaker, not vibes."
 */
import type { RiskReport, RiskFinding, RiskLevel } from "./types.js";

export type SignDecision = "ALLOW" | "WARN" | "REQUIRE_HUMAN";

/**
 * Finding ids whose underlying action is IRREVERSIBLE or hands an attacker
 * lasting control. Sending value out, handing over an authority, granting a
 * delegate, reassigning account ownership, deploying/upgrading code, or touching
 * a flagged/burn address cannot simply be undone by the user afterward.
 */
export const IRREVERSIBLE_FINDINGS = new Set<string>([
  "SET_AUTHORITY",
  "ACCOUNT_REASSIGN",
  "TOKEN_DELEGATE_APPROVE",
  "FULL_TOKEN_ACCOUNT_DRAIN",
  "LARGE_TOKEN_OUTFLOW",
  "LARGE_SOL_OUTFLOW",
  "PROGRAM_DEPLOY_OR_UPGRADE",
  "FLAGGED_ADDRESS",
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
  /** Human-readable reasons for the decision. */
  reasons: string[];
  /** The findings that triggered the irreversible gate, if any. */
  irreversible: RiskFinding[];
}

const RANK: Record<RiskLevel, number> = { info: 0, low: 1, medium: 2, high: 3 };

/**
 * Decide whether a transaction is safe for an agent to sign autonomously.
 * Anything with irreversible blast radius (or high overall risk) gates to a human.
 */
export function decide(
  report: RiskReport,
  options: CircuitBreakerOptions = {},
): CircuitBreakerDecision {
  const irreversibleSet = options.irreversibleFindings ?? IRREVERSIBLE_FINDINGS;
  const requireAt = RANK[options.requireHumanAtLevel ?? "high"];
  const warnAt = RANK[options.warnAtLevel ?? "medium"];

  const irreversible = report.findings.filter(
    (f) => f.level !== "info" && irreversibleSet.has(f.id),
  );

  if (irreversible.length > 0) {
    return {
      action: "REQUIRE_HUMAN",
      reasons: [
        "Irreversible action with lasting blast radius; a human signature is required.",
        ...irreversible.map((f) => `${f.id}: ${f.title}`),
      ],
      irreversible,
    };
  }

  if (RANK[report.level] >= requireAt) {
    return {
      action: "REQUIRE_HUMAN",
      reasons: [`Overall risk is ${report.level}; a human signature is required.`],
      irreversible: [],
    };
  }

  if (RANK[report.level] >= warnAt) {
    return {
      action: "WARN",
      reasons: [`Flagged ${report.level} risk; review before proceeding.`, report.summary],
      irreversible: [],
    };
  }

  return {
    action: "ALLOW",
    reasons: ["No irreversible actions and no medium or high risk signals."],
    irreversible: [],
  };
}
