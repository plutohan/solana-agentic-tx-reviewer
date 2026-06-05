/**
 * POST /api/v1/review  -- the stable, public, versioned review endpoint.
 *
 * Body: { signature?: string, rawTransaction?: string, cluster?: "mainnet-beta"|"devnet"|"testnet" }
 *   - signature      -> review a confirmed transaction
 *   - rawTransaction -> simulate and review an unsigned (base64) transaction
 * Returns: { apiVersion: "v1", ...ReviewResult } (200) | { error } (4xx/5xx)
 *
 * Differences from the internal /api/review:
 *   - CORS enabled so wallets and agents can call it from the browser.
 *   - Best-effort rate limiting (per IP) and optional API-key gating.
 *   - Does NOT accept a client-supplied rpcUrl. Public callers always use the
 *     server's configured RPC, which removes the SSRF surface for this endpoint.
 *
 * Consumed by the official SDK (see /sdk). Docs at /docs/API.md and the machine
 * spec at GET /api/v1/openapi.json.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { reviewTransaction, ReviewError } from "@/lib/review";
import type { Cluster } from "@/lib/types";
import { checkRateLimit } from "@/lib/ratelimit";

/** Length-guarded constant-time string compare for the API key. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const MAX_BODY_BYTES = 16_384;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...CORS, ...extra } });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  // Optional API-key gate. If PUBLIC_API_KEYS (comma-separated) is set, require a
  // matching x-api-key header. If unset, the endpoint is open (free PoC default).
  const configured = process.env.PUBLIC_API_KEYS?.trim();
  if (configured) {
    const allowed = configured.split(",").map((k) => k.trim()).filter(Boolean);
    const provided = req.headers.get("x-api-key")?.trim() ?? "";
    if (!provided || !allowed.some((k) => safeEqual(k, provided))) {
      return json({ error: "Invalid or missing API key. Send it in the x-api-key header." }, 401);
    }
  }

  // Best-effort per-IP rate limit (see lib/ratelimit for the production caveat).
  // Key on the IP set by our trusted proxy, NOT the client-supplied leftmost
  // X-Forwarded-For (spoofable). On Vercel x-real-ip is the true client IP;
  // otherwise fall back to the rightmost XFF entry (added by the last proxy).
  const ip =
    req.headers.get("x-real-ip")?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    "unknown";
  const rl = checkRateLimit(ip);
  const rlHeaders = {
    "X-RateLimit-Remaining": String(rl.remaining),
    "X-RateLimit-Reset": String(rl.resetSeconds),
  };
  if (!rl.ok) {
    return json(
      { error: "Rate limit exceeded. Please slow down and try again shortly." },
      429,
      { ...rlHeaders, "Retry-After": String(rl.resetSeconds) },
    );
  }

  // Cap the body before parsing. The legitimate payload is a signature or a small
  // base64 tx, so a few KB is generous; this avoids buffering large unauthenticated bodies.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "Request body too large." }, 413, rlHeaders);
  }
  let body: {
    signature?: string;
    rawTransaction?: string;
    cluster?: Cluster;
  };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: "Request body too large." }, 413, rlHeaders);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON body" }, 400, rlHeaders);
  }

  if (!body?.signature && !body?.rawTransaction) {
    return json(
      { error: "Provide either `signature` (confirmed tx) or `rawTransaction` (base64 unsigned tx)." },
      400,
      rlHeaders,
    );
  }

  try {
    const result = await reviewTransaction({
      signature: body.signature,
      rawTransaction: body.rawTransaction,
      cluster: body.cluster,
      // Intentionally no rpcUrl: public callers use the server's configured RPC.
    });
    return json({ apiVersion: "v1", ...result }, 200, rlHeaders);
  } catch (e) {
    if (e instanceof ReviewError) {
      return json({ error: e.message }, e.status, rlHeaders);
    }
    // Do not reflect internal error detail to unauthenticated callers.
    return json({ error: "Unexpected server error." }, 500, rlHeaders);
  }
}
