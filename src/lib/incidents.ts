import type { RiskLevel } from "@/lib/types";

/**
 * Real, documented Solana abuse transactions run through the live reviewer.
 * Every signature and verdict here is reproducible: open the permalink (or call
 * the public API) and you get the same result on the same on-chain transaction.
 *
 * The verdicts below were recorded from the deployed engine on these exact
 * signatures. The "limitation" case (Drift) is included on purpose: an honest
 * demo shows what static review does NOT catch, not just what it does.
 */
export interface IncidentFinding {
  level: RiskLevel;
  id: string;
  title: string;
}

export interface Incident {
  slug: string;
  name: string;
  loss: string;
  date: string;
  signature: string;
  level: RiskLevel;
  score: number;
  outcome: "caught" | "limitation";
  findings: IncidentFinding[];
  mechanism: string;
  verdict: string;
  source: { label: string; url: string };
}

export const INCIDENTS: Incident[] = [
  {
    slug: "slowmist-owner-hijack",
    name: "SlowMist: wallet owner-permission hijack",
    loss: "~$3M+",
    date: "2025-11-26",
    signature:
      "524t8LW1PFWd4DLYDgvtKxCX6HmxLFy2Ho9YSGzuo9mX4iiGDhtBTejx7z7bK4C9RocL8hfeuKF1QaYMnK3itMVJ",
    level: "high",
    score: 93,
    outcome: "caught",
    findings: [
      { level: "high", id: "ACCOUNT_REASSIGN", title: "Reassigns account ownership (System Assign)" },
      { level: "high", id: "TOKEN_DELEGATE_APPROVE", title: "Approves an UNLIMITED token delegate (x2)" },
      { level: "medium", id: "UNKNOWN_PROGRAM", title: "Interacts with an unrecognized program" },
    ],
    mechanism:
      "A System assign silently reassigns the victim's own account owner to the attacker (GKJB...wbzQ), alongside two unlimited token approvals. A wallet simulation shows no fund movement, so it looks safe.",
    verdict:
      "Flagged HIGH (93/100) before signing. The owner reassignment and the unlimited approvals are irreversible, so the circuit breaker returns REQUIRE_HUMAN. This is exactly the silent owner-change that a balance-diff simulation misses.",
    source: {
      label: "SlowMist post-mortem",
      url: "https://slowmist.medium.com/beware-of-solana-phishing-attacks-wallet-owner-permissions-may-be-altered-708bbb30518e",
    },
  },
  {
    slug: "pyth-address-poisoning",
    name: "PYTH address-poisoning",
    loss: "~$2.91M",
    date: "2024-11-23",
    signature:
      "T3vqZjMEi8MrJ34pwgnPG1ZjrFwygw6KYzij4Rt8dcFp2gZMqurHxC2Ta9gK7gELq2XXr4xpyotUYZryvQ2h5RP",
    level: "high",
    score: 45,
    outcome: "caught",
    findings: [
      { level: "high", id: "FULL_TOKEN_ACCOUNT_DRAIN", title: "Sends the full token-account balance out" },
    ],
    mechanism:
      "The victim sent about 7M PYTH (~$2.91M) to a lookalike 'poison' address (4yfu...izcY) that mimics the intended recipient (4yfu...gnhY), copied from a dusting transaction.",
    verdict:
      "Flagged HIGH as a full-balance outflow, enough to make you stop before signing. Honest limit: we flag the magnitude, not the lookalike itself; detecting the address resemblance needs cross-transaction history the engine does not hold.",
    source: {
      label: "Scam Sniffer / Pine Analytics",
      url: "https://pineanalytics.substack.com/p/solana-account-dusting-and-address",
    },
  },
  {
    slug: "vanish-toctou-drainer",
    name: "Vanish drainer (TOCTOU bit-flip)",
    loss: "~$3K (this tx)",
    date: "2024-02-10",
    signature:
      "EPbgcCqcxrG441YfD1jqi91a7fx5ZYe9F3wkaFD8VeR4UPwp2TthHFtMyutCJ2VGeyvj7ZZCCnV7Y1n3HwWZ8it",
    level: "high",
    score: 80,
    outcome: "caught",
    findings: [
      { level: "high", id: "FULL_TOKEN_ACCOUNT_DRAIN", title: "Sends the full token-account balance out" },
      { level: "medium", id: "UNKNOWN_PROGRAM", title: "Interacts with an unrecognized program" },
      { level: "low", id: "MANY_WRITABLE_ACCOUNTS", title: "Many writable accounts" },
    ],
    mechanism:
      "A time-of-check/time-of-use drainer. The signed transaction simulates benign, then the attacker flips on-chain state about 7 blocks later so execution sweeps the wallet through an opaque program (HkRd...oynz).",
    verdict:
      "The realized drain is flagged HIGH. And before signing, the opaque attacker program alone returns REQUIRE_HUMAN (do not auto-sign what you cannot inspect). This is the case simulation-only tools miss: the simulation was benign, the execution was a drain.",
    source: {
      label: "Blockaid: dissecting TOCTOU attacks",
      url: "https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing",
    },
  },
  {
    slug: "drift-update-admin",
    name: "Drift Protocol exploit",
    loss: "~$285M",
    date: "2026-04-01",
    signature:
      "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1",
    level: "medium",
    score: 35,
    outcome: "limitation",
    findings: [
      { level: "medium", id: "UNKNOWN_PROGRAM", title: "Interacts with unrecognized programs" },
      { level: "low", id: "DURABLE_NONCE_PRESENT", title: "Uses a durable nonce (delayed execution)" },
    ],
    mechanism:
      "A DPRK-linked group socially engineered Drift's Squads multisig signers into pre-signing (via durable nonces) a governance transaction that handed program admin to the attacker, who then drained ~$285M.",
    verdict:
      "Honestly, the engine would NOT have blocked this. The damaging transaction was a valid multisig governance action, and the privilege handover was a Drift-specific UpdateAdmin CPI, not a System or SPL instruction we detect. We raise only a low durable-nonce note plus 'unknown program'. The root cause (key and governance compromise) is upstream of any transaction reviewer. What would help: per-program admin-change decoding, on the roadmap.",
    source: {
      label: "Chainalysis / QuillAudits",
      url: "https://www.chainalysis.com/blog/lessons-from-the-drift-hack/",
    },
  },
];
