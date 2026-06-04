/**
 * AI explanation layer.
 *
 * Today this returns a deterministic, template-based natural-language summary so
 * the PoC runs with zero API keys and zero cost. The seam for a real LLM is
 * fully defined: `buildPrompt()` produces the exact context we would send, and
 * the provider switch in `explainTransaction()` shows where an OpenAI/Anthropic
 * call slots in. Flip AI_PROVIDER + add a key to upgrade — no other code changes.
 */
import type { ParsedTransaction, RiskReport, AiExplanation } from "./types";
import { formatSol, formatTokenAmount, shortPubkey } from "./format";

export interface ExplainOptions {
  provider?: AiExplanation["provider"];
}

/**
 * Build the structured context string we would hand to an LLM. Kept as a pure,
 * exported function so it can be unit-tested and reused by a real provider call.
 */
export function buildPrompt(tx: ParsedTransaction, risk: RiskReport): string {
  return [
    "You are a Solana transaction security reviewer. Explain the following",
    "transaction to a non-expert in plain English, then summarize its risk.",
    "Only use the facts provided — never invent addresses, amounts, or intent.",
    "",
    `Signature: ${tx.signature}`,
    `Cluster: ${tx.cluster} | Slot: ${tx.slot} | Success: ${tx.success}`,
    `Fee: ${tx.feeSol} SOL | Fee payer: ${tx.feePayer}`,
    `Signers: ${tx.signers.join(", ") || "none"}`,
    `Programs: ${tx.programsInvoked
      .map((p) => `${p.name ?? p.programId} x${p.count}`)
      .join(", ")}`,
    `Token balance changes: ${JSON.stringify(tx.tokenBalanceChanges)}`,
    `Instructions: ${JSON.stringify(
      tx.instructions.map((i) => ({
        program: i.programName ?? i.programId,
        type: i.parsedType,
      })),
    )}`,
    `Deterministic risk: level=${risk.level} score=${risk.score} ` +
      `findings=[${risk.findings.map((f) => f.id).join(", ")}]`,
  ].join("\n");
}

/**
 * Main entry point. Returns a placeholder explanation unless a real provider is
 * configured (and even then, falls back to the placeholder if no key is set).
 */
export async function explainTransaction(
  tx: ParsedTransaction,
  risk: RiskReport,
  options: ExplainOptions = {},
): Promise<AiExplanation> {
  const provider =
    options.provider ??
    (process.env.AI_PROVIDER as AiExplanation["provider"]) ??
    "placeholder";

  if (provider === "openai" || provider === "anthropic") {
    // --- Real LLM integration goes here (intentionally not wired in the PoC) ---
    //
    //   const prompt = buildPrompt(tx, risk);
    //   const text = await callProvider(provider, prompt); // OpenAI/Anthropic SDK
    //   return { provider, model, summary: text, bullets: [...], caveats: [...],
    //            generatedAt: new Date().toISOString() };
    //
    // Until a key is configured we deliberately fall through to the deterministic
    // explanation so the app always works.
  }

  return placeholderExplanation(tx, risk);
}

function placeholderExplanation(
  tx: ParsedTransaction,
  risk: RiskReport,
): AiExplanation {
  const when = tx.blockTime
    ? new Date(tx.blockTime * 1000).toUTCString()
    : "an unknown time";
  const status = tx.success ? "succeeded" : "failed";
  const programNames =
    tx.programsInvoked.map((p) => p.name ?? shortPubkey(p.programId)).join(", ") ||
    "no programs";

  const bullets: string[] = [
    `Status: ${tx.success ? "Success" : "Failed"} · Slot ${tx.slot} · Fee ${formatSol(tx.feeSol)} SOL`,
    `Fee payer / primary signer: ${tx.feePayer}`,
    `Programs: ${programNames}`,
  ];

  const solMoves = tx.accounts
    .filter((a) => a.solChangeLamports !== 0)
    .sort((a, b) => Math.abs(b.solChangeLamports) - Math.abs(a.solChangeLamports))
    .slice(0, 4);
  for (const a of solMoves) {
    bullets.push(
      `${a.solChangeSol >= 0 ? "+" : ""}${formatSol(a.solChangeSol)} SOL · ${shortPubkey(a.pubkey)}`,
    );
  }
  for (const c of tx.tokenBalanceChanges.slice(0, 5)) {
    bullets.push(
      `${c.delta >= 0 ? "+" : ""}${formatTokenAmount(c.delta, c.decimals)} of mint ${shortPubkey(c.mint)} · ${shortPubkey(c.owner ?? c.account)}`,
    );
  }

  const tokenSentence =
    tx.tokenBalanceChanges.length > 0
      ? `${tx.tokenBalanceChanges.length} SPL token balance change(s) were detected. `
      : "No SPL token balance changes were detected. ";

  const riskSentence = risk.findings.length
    ? `The deterministic risk check rated this ${risk.level.toUpperCase()} (score ${risk.score}/100), with notable signals: ${risk.findings
        .slice(0, 3)
        .map((f) => f.title)
        .join("; ")}.`
    : `The deterministic risk check rated this ${risk.level.toUpperCase()} (score ${risk.score}/100) with no notable signals.`;

  const summary =
    `This transaction ${status} on ${tx.cluster} at ${when} (slot ${tx.slot}). ` +
    `It was signed by ${tx.signers.length} account(s), paid ${formatSol(tx.feeSol)} SOL in fees, ` +
    `and interacted with ${tx.programsInvoked.length} program(s): ${programNames}. ` +
    tokenSentence +
    riskSentence;

  return {
    provider: "placeholder",
    summary,
    bullets,
    caveats: [
      "This explanation is generated by a deterministic, rule-based engine — not a large language model. The LLM hook is stubbed and ready to connect to OpenAI/Anthropic.",
      "Risk heuristics are best-effort signals, not a security guarantee or financial advice. Always verify on a trusted block explorer before acting.",
    ],
    generatedAt: new Date().toISOString(),
  };
}
