/**
 * solana-tx-reviewer-sdk
 *
 * A tiny, dependency-free client for the Solana Agentic Transaction Reviewer API.
 * Works in Node 18+ and modern browsers (uses the global `fetch`).
 *
 *   import { SolanaTxReviewer } from "solana-tx-reviewer-sdk";
 *   const reviewer = new SolanaTxReviewer();
 *   const result = await reviewer.reviewSignature("<signature>");
 *   if (result.risk.level === "high") block();
 *
 * Everything is read-only. The SDK never signs or sends a transaction.
 */

export type Cluster = "mainnet-beta" | "devnet" | "testnet";
export type RiskLevel = "info" | "low" | "medium" | "high";

export interface ReviewRequest {
  /** Base58 confirmed transaction signature. */
  signature?: string;
  /** Base64-serialized unsigned transaction (simulated read-only, before signing). */
  rawTransaction?: string;
  cluster?: Cluster;
}

export interface RiskFinding {
  id: string;
  level: RiskLevel;
  title: string;
  detail: string;
  evidence?: string[];
}

export interface RiskReport {
  /** 0 to 100, higher is riskier. */
  score: number;
  level: RiskLevel;
  summary: string;
  findings: RiskFinding[];
}

export interface AiExplanation {
  /** "anthropic" | "openai" | "placeholder" */
  provider: string;
  model?: string | null;
  summary: string;
  bullets: string[];
  caveats: string[];
  generatedAt?: string;
}

export interface ProgramInvocation {
  programId: string;
  name?: string | null;
  count: number;
}

export interface TokenBalanceChange {
  account: string;
  owner?: string | null;
  mint: string;
  symbol?: string | null;
  decimals: number;
  delta: number;
  uiPreAmount: number | null;
  uiPostAmount: number | null;
}

/**
 * Normalized transaction. Only the most-used fields are typed here; the API may
 * include more (accounts, instructions, logMessages, slot, blockTime, etc.),
 * which is why the type stays open.
 */
export interface ParsedTransaction {
  signature: string;
  cluster: Cluster;
  success: boolean;
  simulated?: boolean;
  feeSol: number;
  feeLamports: number;
  feePayer: string;
  signers: string[];
  writableAccounts: string[];
  programsInvoked: ProgramInvocation[];
  tokenBalanceChanges: TokenBalanceChange[];
  logMessages: string[];
  [key: string]: unknown;
}

export interface ReviewResult {
  apiVersion?: string;
  request: ReviewRequest;
  transaction: ParsedTransaction;
  risk: RiskReport;
  explanation: AiExplanation;
}

export interface ReviewerOptions {
  /** Base URL of a reviewer deployment. Defaults to the public instance. */
  baseUrl?: string;
  /** Sent as the `x-api-key` header when the server requires keys. */
  apiKey?: string;
  /** Inject a fetch implementation (tests, custom agents). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Abort the request after this many ms (default 30000). */
  timeoutMs?: number;
}

export class ReviewerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ReviewerError";
    this.status = status;
  }
}

const DEFAULT_BASE_URL = "https://solana-agentic-tx-reviewer.vercel.app";

export class SolanaTxReviewer {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ReviewerOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new Error(
        "No fetch implementation found. Use Node 18+, a browser, or pass `fetch` in options.",
      );
    }
    this.fetchImpl = f;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Review a confirmed transaction by its signature. */
  reviewSignature(signature: string, cluster: Cluster = "mainnet-beta"): Promise<ReviewResult> {
    return this.review({ signature, cluster });
  }

  /** Simulate and review an unsigned base64 transaction, before signing. */
  reviewUnsigned(rawTransaction: string, cluster: Cluster = "mainnet-beta"): Promise<ReviewResult> {
    return this.review({ rawTransaction, cluster });
  }

  /** Low-level review call. Provide exactly one of `signature` or `rawTransaction`. */
  async review(request: ReviewRequest): Promise<ReviewResult> {
    if (!request.signature && !request.rawTransaction) {
      throw new ReviewerError(
        "Provide either `signature` or `rawTransaction`.",
        400,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/v1/review`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ReviewerError(
        (err as Error)?.name === "AbortError"
          ? `Request timed out after ${this.timeoutMs}ms`
          : `Network error: ${(err as Error)?.message ?? "unknown"}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ReviewerError(`Unexpected non-JSON response (HTTP ${res.status})`, res.status);
    }
    if (!res.ok) {
      const message =
        (data as { error?: string })?.error ?? `Request failed (HTTP ${res.status})`;
      throw new ReviewerError(message, res.status);
    }
    return data as ReviewResult;
  }

  /** Fetch the machine-readable OpenAPI spec for this deployment. */
  async openapi(): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/openapi.json`);
    return res.json();
  }
}

/** Convenience factory equivalent to `new SolanaTxReviewer(options)`. */
export function createReviewer(options: ReviewerOptions = {}): SolanaTxReviewer {
  return new SolanaTxReviewer(options);
}
