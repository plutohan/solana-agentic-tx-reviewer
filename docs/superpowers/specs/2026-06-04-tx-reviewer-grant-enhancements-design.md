# Design: Grant-Enhancement Round — Solana Agentic Transaction Reviewer

**Date:** 2026-06-04
**Status:** Approved (build plan: grant-optimized; pre-sign = roadmap milestone)
**Method:** superpowers/brainstorming → multi-agent discovery pass → this spec

## Goal

Maximize win-probability for the Superteam **Agentic Engineering** micro-grant (~200 USDG, Solana Earn) by making the working PoC **demonstrable and visibly on-theme**, not by maximizing technical depth.

## Key discovery findings (medium-confidence; rubric is inferred)

- The grant is fast/high-volume, judged on **Project Details, Proof of Work (live URL + public GitHub repo), an AI session transcript proving an agentic build, a Colosseum Crowdedness Score, and dated milestones + one KPI** — there is no rubric line for simulation depth.
- Therefore leverage = **demonstrability + "agentic" framing**, run two ways at once: *built-WITH-agents* and *becoming-AN-agent* (the reviewer as the judge step in an agent loop).
- **Pre-sign simulation** is the strongest *long-term* differentiator but the *weakest leverage-per-hour* here (invisible in a screenshot, costliest to make trustworthy) → keep it as the **headline roadmap milestone**.

## Scope (this round)

1. **git init + commit** (local) — done first; required for Proof of Work.
2. **Heuristic tuning** (`programs.ts`, `heuristics.ts`, new `watchlist.ts`):
   - Register confirmed program IDs (PumpSwap, pump.fun fee, Raydium CLMM/CPMM, Meteora DLMM/DAMM v2, Phoenix, Lifinity v2, Jito tip) + a `DEX_PROGRAM_IDS` set + `WSOL_MINT`.
   - Exclude wrapped SOL from drain/outflow rules **only** (it is transient / double-counts native SOL).
   - **Defensive** swap-aware downgrade: relabel a full-drain / large-outflow to a `TOKEN_SWAP` finding at `low` **only when** the same owner also receives a different mint (or net native SOL) **and** a known DEX program is present **and** the inflow passes a dust guard. Relabel, never silently clear.
   - Scoring de-saturation: dedup same-id findings; diminishing returns (`weight × 0.5^k`) so a routine swap → LOW (<25) while a real drainer → HIGH (≥70). Do **not** lower `LEVEL_WEIGHT`.
   - Watchlist rule: a curated, clearly-caveated flagged-address/program list that upgrades a generic `UNKNOWN_PROGRAM` to a named `FLAGGED_ADDRESS` high finding.
3. **LLM wiring** (`ai.ts`): real dual Anthropic/OpenAI calls behind the existing seam, **free placeholder default** + graceful fallback; structured JSON → `AiExplanation`. (Tool-calling noted as the next agentic step.)
4. **Shareable permalink** (`app/tx/[signature]/page.tsx` + `opengraph-image.tsx`): server-renders the existing `reviewTransaction` pipeline; Next 16 `ImageResponse` OG card (level/score/short-sig) so a pasted link unfurls into a risk card.
5. **Watchlist** — see 2 (data + rule).
6. **Narrative** (`APPLICATION_SUMMARY.md`, `README.md`): foreground the multi-agent build + agent-loop framing; mark repo/contact/wallet placeholders.

**Out of scope (roadmap):** pre-sign `simulateTransaction` path; public GitHub push; Vercel deploy; `/apply-grant` artifacts.

## Architecture notes

- All changes reuse the existing `ParsedTransaction` / `RiskReport` / `AiExplanation` contract; `ResultView`, `reviewTransaction`, and the API are untouched in shape.
- The permalink route reuses `reviewTransaction` server-side (no new risk logic).
- No new dependencies (LLM via `fetch`; OG via Next built-in `ImageResponse`).

## Verification

- `tsc --noEmit` + `next build` clean.
- Live regression on real signatures: routine Jupiter swap → LOW; pump.fun sell → relabeled `TOKEN_SWAP` (not drain); a synthetic/known drainer pattern → HIGH.
- LLM path: verify graceful fallback with no key; verify request shape against Anthropic/OpenAI API specs (live call requires the owner's key).
- Adversarial review workflow over the new code before claiming done.
