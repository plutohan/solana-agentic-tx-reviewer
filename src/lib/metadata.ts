/**
 * Token metadata enrichment.
 *
 * Resolves mint -> { symbol, name, logoURI } so the UI and explanation can show
 * "-1,250 USDC" instead of a raw mint and base-unit delta. A small registry of
 * common mints covers the frequent cases offline; everything else is a cached,
 * best-effort Jupiter token lookup that degrades gracefully to the raw mint.
 */
import type { TokenBalanceChange } from "./types";
import { WSOL_MINT } from "./programs";

interface TokenMeta {
  symbol?: string;
  name?: string;
  logoURI?: string;
}

const KNOWN: Record<string, TokenMeta> = {
  [WSOL_MINT]: { symbol: "SOL", name: "Wrapped SOL" },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD" },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter" },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", name: "dogwifhat" },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: { symbol: "JTO", name: "Jito" },
};

const cache = new Map<string, TokenMeta | null>();

async function fetchMeta(mint: string): Promise<TokenMeta | null> {
  if (KNOWN[mint]) return KNOWN[mint];
  if (cache.has(mint)) return cache.get(mint) ?? null;

  let meta: TokenMeta | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `https://datapi.jup.ag/v1/assets/search?query=${mint}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (res.ok) {
      const arr = (await res.json()) as
        | { id: string; symbol?: string; name?: string; icon?: string }[]
        | null;
      const hit = Array.isArray(arr) ? arr.find((a) => a.id === mint) : null;
      if (hit && (hit.symbol || hit.name)) {
        meta = { symbol: hit.symbol, name: hit.name, logoURI: hit.icon };
      }
    }
  } catch {
    // network/timeout/parse error: leave meta null and degrade to the raw mint
  }
  cache.set(mint, meta);
  return meta;
}

/** Enrich token balance changes in place. Never throws. */
export async function enrichTokenMetadata(
  changes: TokenBalanceChange[],
): Promise<void> {
  if (changes.length === 0) return;
  const mints = [...new Set(changes.map((c) => c.mint))];
  const metas = await Promise.all(mints.map((m) => fetchMeta(m)));
  const byMint = new Map(mints.map((m, i) => [m, metas[i]] as const));
  for (const c of changes) {
    const m = byMint.get(c.mint);
    if (m) {
      c.symbol = m.symbol;
      c.name = m.name;
      c.logoURI = m.logoURI;
    }
  }
}
