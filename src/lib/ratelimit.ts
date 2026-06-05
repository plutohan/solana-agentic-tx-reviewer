/**
 * Best-effort in-memory rate limiter for the public API.
 *
 * NOTE: serverless instances do not share memory, so this caps abuse per
 * instance, not globally. For real production limits use a shared store
 * (Upstash/Redis). It is intentionally simple for the PoC and documented as such.
 *
 * Memory is bounded: expired buckets are swept opportunistically (at most once
 * per window) and the Map has a hard size ceiling, so a flood of distinct keys
 * cannot grow it without bound.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const MAX_BUCKETS = 50_000;

const buckets = new Map<string, { count: number; reset: number }>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [k, v] of buckets) {
    if (now > v.reset) buckets.delete(k);
  }
  // Hard ceiling: if still oversized, drop oldest-inserted entries (Map keeps
  // insertion order) so memory stays bounded even under a unique-key flood.
  if (buckets.size > MAX_BUCKETS) {
    let toDrop = buckets.size - MAX_BUCKETS;
    for (const k of buckets.keys()) {
      buckets.delete(k);
      if (--toDrop <= 0) break;
    }
  }
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetSeconds: number;
}

export function checkRateLimit(
  key: string,
  max = MAX_PER_WINDOW,
  windowMs = WINDOW_MS,
): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: max - 1, resetSeconds: Math.ceil(windowMs / 1000) };
  }
  const resetSeconds = Math.max(0, Math.ceil((bucket.reset - now) / 1000));
  if (bucket.count >= max) {
    return { ok: false, remaining: 0, resetSeconds };
  }
  bucket.count++;
  return { ok: true, remaining: max - bucket.count, resetSeconds };
}
