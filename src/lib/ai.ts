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
const SYSTEM_PROMPT =
  "You are a Solana transaction security reviewer. Given structured facts about a " +
  "transaction, explain in plain English what it did, then summarize its risk for a " +
  "non-expert. Use ONLY the provided facts — never invent addresses, amounts, or intent. " +
  "Be concise and concrete. Respond with strict minified JSON only.";

const STANDARD_CAVEAT =
  "Risk heuristics are best-effort signals, not a security guarantee or financial advice. Always verify on a trusted block explorer before acting.";

/**
 * Main entry point. Calls a real LLM only when AI_PROVIDER + a matching API key
 * are configured; otherwise (and on ANY error) returns the deterministic
 * placeholder so the app always works and stays free by default.
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

  if (provider === "anthropic" || provider === "openai") {
    try {
      const llm = await callLlm(provider, tx, risk);
      if (llm) return llm;
    } catch {
      // Any failure (missing key, network, rate limit, bad JSON) degrades to placeholder.
    }
  }

  return placeholderExplanation(tx, risk);
}

async function callLlm(
  provider: "anthropic" | "openai",
  tx: ParsedTransaction,
  risk: RiskReport,
): Promise<AiExplanation | null> {
  const user =
    buildPrompt(tx, risk) +
    '\n\nRespond ONLY with minified JSON of the form ' +
    '{"summary": string, "bullets": string[], "caveats": string[]}.';

  const raw =
    provider === "anthropic"
      ? await callAnthropic(SYSTEM_PROMPT, user)
      : await callOpenAI(SYSTEM_PROMPT, user);
  if (!raw) return null;

  const parsed = parseJsonObject(raw.text);
  if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    return null;
  }

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    provider,
    model: raw.model,
    summary: parsed.summary,
    bullets: strings(parsed.bullets).slice(0, 12),
    caveats: [...strings(parsed.caveats), STANDARD_CAVEAT],
    generatedAt: new Date().toISOString(),
  };
}

async function callAnthropic(
  system: string,
  user: string,
): Promise<{ text: string; model: string } | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      temperature: 0.2,
      // Cache the static system prompt across requests (5-min TTL).
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
  return { text, model: data.model ?? model };
}

async function callOpenAI(
  system: string,
  user: string,
): Promise<{ text: string; model: string } | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  return { text, model: data.model ?? model };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
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
      "This explanation is generated by a deterministic, rule-based engine — not a large language model. A real LLM is wired in: set AI_PROVIDER=anthropic|openai plus an API key to enable it.",
      "Risk heuristics are best-effort signals, not a security guarantee or financial advice. Always verify on a trusted block explorer before acting.",
    ],
    generatedAt: new Date().toISOString(),
  };
}
