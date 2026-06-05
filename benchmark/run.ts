/**
 * Risk-engine benchmark runner.
 *
 * Runs assessRisk over the labeled corpus and reports precision / recall / F1 /
 * accuracy, then guards against regressions: if any fixture's flagged decision
 * differs from the documented `engineFlags`, it exits non-zero (so a rule change
 * that silently alters classification is caught in CI).
 *
 * Run: npm run benchmark
 */
import { assessRisk, type RiskLevel } from "@solana-tx-reviewer/core";
import { FIXTURES } from "./fixtures";

const isFlagged = (level: RiskLevel) => level === "medium" || level === "high";
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

let tp = 0, fp = 0, tn = 0, fn = 0, regressions = 0;
const rows: string[] = [];
const gaps: string[] = [];

for (const f of FIXTURES) {
  const report = assessRisk(f.tx);
  const flagged = isFlagged(report.level);
  const truthRisky = f.truth === "risky";

  if (truthRisky && flagged) tp++;
  else if (truthRisky && !flagged) fn++;
  else if (!truthRisky && flagged) fp++;
  else tn++;

  const regressed = flagged !== f.engineFlags;
  if (regressed) regressions++;

  const verdict = regressed
    ? "!! REGRESSION"
    : flagged === truthRisky
      ? "ok"
      : flagged
        ? "FP"
        : "FN";

  rows.push(
    `${f.name.padEnd(26)} truth=${f.truth.padEnd(6)} -> ${report.level.padEnd(6)} score=${String(report.score).padStart(3)}  ${verdict}`,
  );
  if (flagged !== truthRisky && f.note) gaps.push(`  - ${f.name}: ${f.note}`);
}

const precision = tp + fp ? tp / (tp + fp) : 0;
const recall = tp + fn ? tp / (tp + fn) : 0;
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
const accuracy = (tp + tn) / FIXTURES.length;

console.log("\nSolana Agentic Transaction Reviewer — risk engine benchmark\n");
console.log(rows.join("\n"));
console.log(`\nFixtures: ${FIXTURES.length}   (decision: flagged = overall level medium or high)`);
console.log(`Confusion: TP=${tp}  FP=${fp}  TN=${tn}  FN=${fn}`);
console.log(`Precision: ${pct(precision)}   Recall: ${pct(recall)}   F1: ${pct(f1)}   Accuracy: ${pct(accuracy)}`);

if (gaps.length) {
  console.log("\nKnown gaps surfaced by this corpus (the honest FP/FN):");
  console.log(gaps.join("\n"));
}

if (regressions > 0) {
  console.error(
    `\n!! ${regressions} fixture(s) changed classification vs documented behavior. ` +
      `If intended, update engineFlags in benchmark/fixtures.ts; otherwise it is a regression.`,
  );
  process.exit(1);
}
console.log("\nNo regressions vs documented behavior.");
