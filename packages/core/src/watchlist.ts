/**
 * Curated watchlist of flagged addresses / programs.
 *
 * BEST-EFFORT and NON-EXHAUSTIVE. This is NOT financial advice and not a
 * judgment that any address is malicious. Add entries ONLY with a citable
 * public source — a false accusation is harmful. The matching logic below is
 * fully wired, so the list can grow without code changes.
 */

export type WatchCategory =
  | "drainer"
  | "scam"
  | "phishing"
  | "sanctioned"
  | "burn";

export interface WatchEntry {
  address: string;
  label: string;
  category: WatchCategory;
  /** Where this entry came from — keep it citable. */
  source: string;
}

/** Flagged wallet/account addresses. */
export const FLAGGED_ADDRESSES: WatchEntry[] = [
  {
    address: "1nc1nerator11111111111111111111111111111111",
    label: "SOL burn / incinerator address — funds sent here are destroyed irreversibly",
    category: "burn",
    source: "Well-known Solana burn address",
  },
  // Add drainer/scam/phishing addresses here, each with a citable public source
  // (e.g. a security advisory, a chain-analysis report). Do not add unverified
  // addresses.
];

/** Flagged program IDs (e.g. known malicious programs). */
export const FLAGGED_PROGRAMS: WatchEntry[] = [
  // Intentionally empty by default. Populate only from public disclosures so we
  // never mislabel a legitimate program. The risk rule already matches these.
];

const BY_ADDRESS = new Map<string, WatchEntry>();
for (const entry of [...FLAGGED_ADDRESSES, ...FLAGGED_PROGRAMS]) {
  BY_ADDRESS.set(entry.address, entry);
}

export function lookupWatch(address: string): WatchEntry | undefined {
  return BY_ADDRESS.get(address);
}
