/** Small, pure formatting helpers shared by the server and the UI. */

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

/** Format a SOL amount with trailing zeros trimmed (4dp >= 1 SOL, 9dp below). */
export function formatSol(sol: number): string {
  if (!Number.isFinite(sol)) return "0";
  const digits = Math.abs(sol) >= 1 ? 4 : 9;
  const fixed = sol.toFixed(digits);
  return fixed.replace(/\.?0+$/, "") || "0";
}

/** Abbreviate a base58 pubkey/signature, e.g. "5xY2…9Qz1". */
export function shortPubkey(value: string, chars = 4): string {
  if (!value) return "";
  if (value.length <= chars * 2 + 1) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}

/** Format a decimal-adjusted token amount with thousands separators. */
export function formatTokenAmount(amount: number, decimals: number): string {
  if (!Number.isFinite(amount)) return String(amount);
  return amount.toLocaleString("en-US", {
    maximumFractionDigits: Math.min(Math.max(decimals, 0), 9),
  });
}

/** True if a string looks like a base58 Solana public key. */
export function isLikelyPubkey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    value.length <= 44 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
  );
}
