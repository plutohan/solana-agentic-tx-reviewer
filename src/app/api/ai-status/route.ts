/**
 * GET /api/ai-status        -> reports which AI config is present (no secrets).
 * GET /api/ai-status?test=1  -> additionally does a minimal live ping to the
 *                              configured provider and reports ok/status/error.
 *
 * Diagnostic only: it never returns key values, only booleans + the upstream
 * error text, so you can tell "AI_PROVIDER not set" from "key/model rejected".
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const provider = process.env.AI_PROVIDER ?? null;
  const anthropicModel = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
  const openaiModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const config = {
    aiProvider: provider,
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    anthropicModel,
    openaiModel,
    willUseRealLlm:
      (provider === "anthropic" && !!process.env.ANTHROPIC_API_KEY) ||
      (provider === "openai" && !!process.env.OPENAI_API_KEY),
  };

  if (new URL(req.url).searchParams.get("test") !== "1") {
    return NextResponse.json(config);
  }

  const probe: Record<string, unknown> = { tested: provider };
  try {
    if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 8,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      probe.ok = res.ok;
      probe.status = res.status;
      if (!res.ok) probe.error = (await res.text()).slice(0, 400);
    } else if (provider === "openai" && process.env.OPENAI_API_KEY) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: openaiModel,
          max_tokens: 8,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      probe.ok = res.ok;
      probe.status = res.status;
      if (!res.ok) probe.error = (await res.text()).slice(0, 400);
    } else {
      probe.note =
        "AI_PROVIDER is not set to anthropic/openai, or the matching key is missing.";
    }
  } catch (e) {
    probe.ok = false;
    probe.error = (e as Error).message;
  }

  return NextResponse.json({ ...config, probe });
}
