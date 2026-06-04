# Solana Agentic Transaction Reviewer

**A lightweight, AI-assisted, read-only tool that turns a raw Solana transaction signature into a plain-English explanation and an explainable risk report — so you understand what you signed (or are about to sign).**

> Status: working proof-of-concept (PoC). Submitted for the Superteam Agentic Engineering Grant (~200 USDG).

---

## 1. The problem: signing blind is dangerous

Every day, Solana users approve transactions they cannot read. A wallet pops up, shows a list of opaque base58 account keys and a "confirm" button, and the user clicks. Block explorers exist, but they are built for engineers — they render instruction data, account indexes, and CPI trees, not "this transaction hands control of your token account to a stranger."

That gap is where drains live. Delegate approvals, `SetAuthority` handovers, full token-account sweeps, and interactions with unknown programs are all perfectly normal-looking in an explorer and devastating in practice. The information needed to catch them is on-chain and public — it just isn't **explained**.

## 2. The solution

The Solana Agentic Transaction Reviewer is a read-only reviewer for exactly this moment. You paste a transaction signature; it does the rest.

It fetches the transaction over Solana RPC (`getParsedTransaction`, `maxSupportedTransactionVersion: 0`), normalizes it into a clean data model (SOL deltas from pre/post balances, SPL token balance changes, flattened top-level **and** inner/CPI instructions, aggregated program invocations), runs a set of deterministic risk heuristics, and produces a natural-language explanation plus a scored risk report. The whole pipeline is **`fetch → parse() → assessRisk() → explainTransaction()`**, exposed as a single `reviewTransaction()` call behind `POST /api/review`. It never signs, never sends, and never holds a key — analysis only.

## 3. Why it matters for Solana, and why now

Three forces converge. **Safety:** drains remain one of the most common ways users lose funds, and the fix is comprehension, not another warning modal. **Onboarding:** as Solana grows beyond power users, "what does this actually do?" must be answerable in one sentence. **Agentic tooling:** the ecosystem is racing toward AI agents that hold keys and act autonomously — and an agent that can *sign* without a structured way to *review* is a liability. A grounded, explainable review layer is the missing safety primitive for that future. This PoC builds exactly that layer.

## 4. What's built (the PoC)

A complete, runnable Next.js 16 (App Router) app. Concretely, in `src/lib/`:

- **`types.ts`** — the shared contract: `ReviewRequest`, `ParsedTransaction`, `AccountSummary`, `InstructionSummary`, `TokenBalanceChange`, `ProgramInvocation`, `RiskReport`, `AiExplanation`, `ReviewResult`.
- **`solana.ts`** — read-only RPC access: `fetchParsedTransaction`, `isValidSignature`, and `resolveRpcUrl` with precedence `request.rpcUrl > SOLANA_RPC_URL > public cluster default`.
- **`parse.ts`** — `parseTransaction()` normalizing the raw RPC response.
- **`programs.ts`** — a curated registry of known program IDs (System, SPL Token / Token-2022, Jupiter v6, Raydium, Orca Whirlpools, pump.fun, Metaplex, and more) powering `resolveProgram` / `isKnownProgram`.
- **`heuristics.ts`** — `assessRisk()`, the deterministic engine (detailed below).
- **`ai.ts`** — `explainTransaction()` and `buildPrompt()`, the natural-language layer.
- **`review.ts` + `src/app/api/review/route.ts`** — orchestration and the Node-runtime API.
- **`src/app/page.tsx`, `src/components/ResultView.tsx`, `RiskBadge.tsx`** — a client UI: signature input, cluster select, optional custom RPC, and a rendered result.

**The risk engine is precise and explainable.** Level weights are `info=0, low=10, medium=25, high=45`; the score is the clamped weighted sum (0–100) and the overall level is the **max** individual finding level. Thresholds: large SOL outflow ≥ 1 SOL (high at ≥ 10), many writable accounts ≥ 12, high fee > 0.01 SOL, large token outflow ≥ 50% of balance. Rules include `FULL_TOKEN_ACCOUNT_DRAIN` (high), `SET_AUTHORITY` (high), `TOKEN_DELEGATE_APPROVE` (medium), `CLOSE_TOKEN_ACCOUNT` (medium), `UNKNOWN_PROGRAM` (medium), `ACCOUNT_REASSIGN` (medium), `PROGRAM_DEPLOY_OR_UPGRADE` (medium), `LARGE_TOKEN_OUTFLOW` (low/medium), plus informational signals (`TX_FAILED`, `NEW_ACCOUNT_CREATION`, `MULTIPLE_SIGNERS`, `COMPUTE_BUDGET_SET`, `MEMO_PRESENT`). Every finding carries human-readable evidence — these are **signals, not verdicts**.

**Toolchain (all brought current for this project):** Node.js 24.16.0 LTS / npm 11.16.0, Next.js 16.2.7 + React 19.2.7 + TypeScript 6.0.3, Tailwind CSS 4.3.0 (CSS-first config, no `tailwind.config.js`), and `@solana/web3.js` 1.98.4 (the v1 line; `@solana/kit` 6.x is noted as a future migration option). The broader machine toolchain (Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2) was updated too, though this read-only web app does not use it.

## 5. The agentic angle

This is built to *become* an agent, not just a viewer. The AI seam is fully defined and deliberately decoupled: `buildPrompt(tx, risk)` already emits the exact, fact-constrained context an LLM would receive ("only use the facts provided — never invent addresses, amounts, or intent"), and `explainTransaction()` carries a `placeholder | openai | anthropic` provider switch gated by `AI_PROVIDER` + an API key. Today it returns a deterministic, template-based explanation — **zero keys, zero cost, always works** — so the PoC is honest and self-contained while the upgrade path is one config flip.

From here, the same structured `ParsedTransaction` + `RiskReport` become an agent's **tools**: a reviewer that an autonomous signer calls as a pre-flight check, extended to *simulate* unsigned transactions before approval, and exposed as a callable tool over an agent protocol. The clean `fetch → parse → assessRisk → explain` contract is precisely what an agent needs to reason about a transaction with grounded facts instead of hallucinations.

## 6. Differentiation

Explorers show data; simulators show state diffs; neither *explains* or *judges*. This tool adds (1) **explainable heuristics** with human-readable evidence and a transparent scoring model, (2) **natural-language output** aimed at non-experts, (3) an **extensible** program registry and rule set, and (4) an **open, well-typed base** any agent or app can build on. It's complementary to explorers, not a replacement — and the safety logic is auditable code, not a black box.

## 7. The ask & use of funds

A modest ~200 USDG to take this from PoC to a genuinely useful public tool: wiring a real LLM provider behind the existing seam, expanding the program registry and heuristic coverage, hardening the client-supplied `rpcUrl` passthrough for production, and adding pre-sign transaction simulation. Detailed deliverables and milestones live in **`MILESTONES.md`**.

**Known limitations (stated plainly):** public RPC rate-limits and prunes old transactions (a custom RPC is supported via input/env); heuristics are signals, not guarantees; the client-supplied `rpcUrl` ships with a baseline SSRF guard (loopback/private/metadata hosts blocked) but a production allowlist is still recommended; there is no persistence and no live LLM yet.

## 8. Links & contact

- **Repository:** `/Users/pluto/dev/solana-agentic-tx-reviewer` _(public repo link: TODO — add before submission)_
- **Roadmap:** see `MILESTONES.md` in this repo.
- **Contact:** _<!-- CONTACT PLACEHOLDER: add name, email, X/Discord, and wallet for grant disbursement -->_

---

*This is a read-only proof-of-concept. It analyzes transactions; it never signs or sends them. Risk heuristics are best-effort signals, not security guarantees or financial advice — always verify on a trusted block explorer before acting.*
