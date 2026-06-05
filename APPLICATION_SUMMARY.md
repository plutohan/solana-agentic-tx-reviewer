# Solana Agentic Transaction Reviewer

**The review step an agent runs before it signs. A read-only tool that turns a raw Solana transaction into a plain-English explanation and a scored, auditable risk report, so a human (or an agent) understands what was signed, or is about to be.**

> Status: BUILT, PUBLIC, and LIVE. Try it: **https://solana-agentic-tx-reviewer.vercel.app**. Code: **https://github.com/plutohan/solana-agentic-tx-reviewer**. Built end-to-end with agents. Submitted for the Superteam Agentic Engineering micro-grant (~200 USDG, Solana Earn).

---

## 1. It is live. Go look.

This is not a slide deck. It is a deployed product. The app runs at **https://solana-agentic-tx-reviewer.vercel.app** on Next.js 16 on Vercel, with the Helius RPC call kept server-side. I verified the live deployment end to end: the home page, a confirmed-signature review, the pre-sign simulation path, a `/tx/<signature>` permalink, and the dynamic OpenGraph risk card all return 200 in production. Paste a signature, or paste an unsigned transaction, and you get an answer. Click "Load a sample" if you have nothing handy.

The whole thing was built with agents. A multi-agent workflow scaffolded it, tuned it, adversarially reviewed it, redesigned it, and documented it across one working session. The MVP shipped in a single roughly three-hour session. The agent session transcript is the proof.

## 2. Agentic engineering, two ways at once

This project carries the grant theme in both directions.

**Built with agents.** Agents wrote the code, then attacked it. A research pass confirmed the on-chain program IDs in the registry. An adversarial-review pass de-risked the heuristics. It found a false positive where a routine Jupiter swap read HIGH "fully drained" off a pool account, and we killed it. Agents brought the toolchain current (Node 24, Next 16, React 19) and wrote the regression suite that now guards every change. The build process is the demo.

**Built to become an agent.** Think of the reviewer as the review step in the agent loop. An agent proposes a transaction, the reviewer judges it (`parse -> heuristics -> explanation`), and a human or higher-level agent approves. An autonomous signer that can act without a structured, grounded way to review is a liability. That review step is the safety primitive Solana's agentic future is missing. The clean `fetch -> parse() -> assessRisk() -> explainTransaction()` contract, exposed as a single `reviewTransaction()` call, is exactly the tool an agent needs to reason about a transaction with facts instead of hallucinations.

## 3. The problem: signing blind

Every day, Solana users and bots approve transactions they cannot read. Wallets render base58 keys you can't make sense of and a "confirm" button. Explorers render instruction data, account indexes, and CPI trees, but not "this hands control of your token account to a stranger." That gap is where drains live. Delegate approvals, `SetAuthority` handovers, and full token-account sweeps look normal in an explorer and are devastating in practice. The information is on-chain and public. It just isn't explained. As agents start holding keys, the gap scales with them.

## 4. What's built

A complete, deployed Next.js 16 (App Router) app. It is **read-only**. It never signs, never sends, never holds a key. It reviews a transaction two ways, and both paths run the exact same `parse -> risk -> explain` pipeline.

**Pre-sign simulation is shipped (`src/lib/presign.ts`). This is the headline feature, and it is built, deployed, and verified live.** You can review an **unsigned** transaction before approving it. The safety layer moved before the signature, which is the whole point of the agent-loop framing. The flow: accept a base64-serialized `VersionedTransaction`, deserialize it, resolve any address lookup tables (v0), then simulate read-only with `connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: 'base64', addresses: writableAccounts } })`. From there it derives SOL and SPL token deltas by diffing the pre-state (`getMultipleAccountsInfo`) against the simulated post-state (token amount is the u64 LE at byte 64, mint decimals come from the mint account at byte 44). It estimates the fee via `getFeeForMessage`. A small discriminator decoder recovers SPL Token and System instruction *types* from the raw instruction data, so the same `parsedType`-dependent heuristics (`setAuthority`, `approve`, `closeAccount`, `createAccount`, and the rest) still fire. It emits the SAME `ParsedTransaction` the confirmed path produces (with `simulated: true`), so the risk engine, the explanation, and the UI are unchanged. I verified it live against mainnet: an unsigned transfer to the burn/incinerator address simulated successfully, showed SOL deltas, and the `FLAGGED_ADDRESS` watchlist rule fired BEFORE signing. Nothing is ever signed or sent. Simulation only.

**Token metadata enrichment is shipped (`src/lib/metadata.ts`).** It resolves a mint to `{ symbol, name, logoURI }` via a small known-token registry (SOL, USDC, USDT, BONK, JUP, WIF, JTO) plus a cached, best-effort Jupiter datapi lookup (`https://datapi.jup.ag/v1/assets/search?query=<mint>`). It degrades gracefully to the raw mint when a token is unknown or the endpoint is unreachable. Token tables and the explanation now show "USDC" and a logo instead of a raw mint and a base-unit delta. `enrichTokenMetadata()` runs inside `reviewTransaction()` for BOTH paths, and it never throws.

**The confirmed-signature path.** You paste a signature. It fetches over Solana RPC (`getParsedTransaction`, `maxSupportedTransactionVersion: 0`), normalizes the result (SOL deltas, SPL token balance changes, flattened top-level **and** inner/CPI instructions, aggregated program invocations), runs deterministic heuristics, and produces a natural-language explanation plus a scored risk report. In `src/lib/`: `types.ts`, `solana.ts` (read-only RPC plus an SSRF guard on client-supplied URLs), `parse.ts`, `presign.ts`, `metadata.ts`, `programs.ts`, `heuristics.ts`, `watchlist.ts`, `ai.ts`, `sample.ts`, and `review.ts`, orchestrated behind `src/app/api/review/route.ts`.

**The API and the types carry both modes.** `ReviewRequest` accepts `signature` or `rawTransaction` (exactly one). `POST /api/review` with `{ rawTransaction: <base64> }` triggers the pre-sign path. Type fields that carry the two modes: `ReviewRequest.rawTransaction`, `ParsedTransaction.simulated`, and `TokenBalanceChange.symbol`/`name`/`logoURI`.

**A "Load a sample" button so the demo never lands on empty input.** `GET /api/sample` (`src/lib/sample.ts`) builds a fresh unsigned transaction server-side (a tiny transfer to the burn address, which always simulates and always trips the watchlist) or fetches a recent successful signature from a busy program. The live demo never shows an empty box or a pruned signature. Results link the signature to Solscan.

**The UI handles both paths.** The home page has a "Confirmed signature" / "Unsigned tx (pre-sign)" toggle, with a textarea for the base64 tx. `ResultView` shows token symbols, plus a "SIMULATED" badge and "Would succeed / Would fail" for the pre-sign path. The shareable permalink is shown only for confirmed reviews. The simulated explanation is framed plainly: "This is a read-only simulation of an unsigned transaction. If signed and sent now, it would..."

**A premium UI redesign, the "forensic instrument" direction.** This does not look like a default Next template. Distinctive type (Bricolage Grotesque and JetBrains Mono via `next/font`, not system fonts), a single cyan accent, and an atmospheric background (dot grid, soft glow, grain). The hero of the risk report is a radial **risk gauge** (`src/components/RiskGauge.tsx`), a 0-to-100 arc colored by level. A reticle wordmark, segmented input tabs, and staggered card entrance motion finish it, and the motion is reduced-motion aware.

**Tuned, signer-scoped, swap-aware heuristics (18 rules, up from 16).** I hardened the engine in `heuristics.ts` against the false positives that plague naive scanners.

- **Signer-scoped drains.** `FULL_TOKEN_ACCOUNT_DRAIN` and `LARGE_TOKEN_OUTFLOW` fire **only on signer-owned token accounts**. Pool and vault accounts (owned by program PDAs) routinely zero out during a swap, so we ignore them. That was the single biggest source of false alarms.
- **Wrapped SOL excluded.** `So111...112` (WSOL) is transient by design. The native-SOL rules already cover it, so it no longer trips token-drain logic.
- **`TOKEN_SWAP` rule (low).** When a would-be drain coincides with the **same signer receiving value back** (a different-mint token inflow above one base unit, or net SOL) **and** a known DEX program is present, we relabel the finding a swap rather than clear it. Dusted fake inflows and undefined owners fail safe to the higher-risk finding. Known venues (`isDexProgram`) include Jupiter v4/v6, Raydium v4/CLMM/CPMM, Orca Whirlpools, Meteora DLMM/DAMM v2, Phoenix, Lifinity v2, PumpSwap AMM, and pump.fun.
- **`FLAGGED_ADDRESS` rule** backed by `watchlist.ts`, a curated, **best-effort, non-exhaustive, not-financial-advice** list. I seeded it honestly with the known SOL burn/incinerator address (program-ID matching is wired but empty by default to avoid false accusations).
- **De-saturated scoring.** `assessRisk()` dedups same-id findings (merging evidence, tagging `xN`) and applies **diminishing returns** (`weight x 0.5^k` for the *k*-th finding at a level). Level weights are unchanged (`info 0 / low 10 / medium 25 / high 45`). A routine swap reads LOW. A real, stacked drainer stays HIGH.

Every finding carries human-readable evidence. These are explainable **signals, not verdicts**.

**A real, dual-provider LLM, wired AND deployed (`src/lib/ai.ts`).** `explainTransaction()` genuinely calls **Anthropic (Claude) or OpenAI** behind the seam, selected by `AI_PROVIDER`, gated on `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` or `OPENAI_API_KEY`/`OPENAI_MODEL`. The Anthropic path uses prompt caching on the static system prompt. In production `AI_PROVIDER=anthropic` and the key are configured, so the integration is live in the deployed app and produces real Claude explanations the moment the Anthropic account is funded. Until then, and on **any** error (missing credits, network, rate limit, bad JSON), it falls back to a free, deterministic, template-based placeholder. Zero keys, zero cost, always works. To be precise about what is on right now: the Claude integration is wired and deployed, and it activates when the API account has credits. Until I fund it, the free explanation is what users see, and the app stays fully functional. I am not claiming live Claude output today. I am claiming the path to it is one trivial step away, because the code already runs against the real API.

**A shareable permalink with an OG risk card.** `GET /tx/<signature>?cluster=...` (`src/app/tx/[signature]/page.tsx`) server-renders the full `reviewTransaction` pipeline, reusing `ResultView` with zero new risk logic. A Next 16 `ImageResponse` OG card (`opengraph-image.tsx`) shows risk level plus score plus a short signature, so a pasted link unfurls into a risk preview. The `metadataBase` auto-detects `NEXT_PUBLIC_SITE_URL`, then `VERCEL_URL`, then localhost. The home page links straight to it via "Open shareable permalink."

**A passing regression suite.** `npm test` runs 24 deterministic checks: 10 over the risk engine in `tests/heuristics.test.ts` plus 14 over pure helpers in `tests/lib.test.ts` (`rawToUi` and the pre-sign instruction decoder). They prove a sell-via-DEX becomes `TOKEN_SWAP` (not HIGH, score < 25), a real drain is HIGH (score >= 45), pool and WSOL noise is filtered, the watchlist fires, base-unit conversion is correct, and the discriminator decoder maps SPL Token and System bytes to the right instruction types. All 24 pass. Pre-sign simulation and metadata need a live RPC, so they sit outside the offline unit suite. I verified those by live integration against mainnet instead.

**Toolchain (current):** Node.js 24.16.0, Next.js 16.2.7, React 19.2.7, TypeScript 6, Tailwind CSS 4.3.0 (CSS-first), `@solana/web3.js` 1.98.4.

## 5. An under-crowded niche

I checked. Across 5,428 Colosseum hackathon projects, the closest match to "review a Solana transaction in plain English and score its risk" is only about 5.5% similar and they fall off from there, none of the related projects won a prize, and the few that exist are consumer browser extensions, not a read-only review primitive for the agent loop. This niche is under-served, not saturated. The full analysis lives in **`colosseum-crowdedness.md`**.

## 6. Honest limitations of the pre-sign path

The pre-sign path is real, but it is not magic, and I want to be precise about its edges. The fee is a best-effort `getFeeForMessage` estimate. The instruction-type decoder covers SPL Token and System. Other programs' instruction types are not decoded, though the balance, program, and watchlist heuristics still apply. It needs a custom RPC, because public RPC rate-limits simulate-with-accounts. And because the blockhash is replaced, the real result after signing can differ if on-chain state changes before you submit.

## 7. Roadmap: what's next

The MVP already shipped. Pre-sign simulation, token metadata, the real LLM integration, the public Vercel deploy, the premium UI, the sample generator, and the 24-check test suite are all done. The remaining roadmap is smaller, and estimates are in days at agent pace.

- **A public review API and SDK so other wallets and agents can use it.** This is the most strategic next step. `POST /api/review` already returns a structured `ReviewResult`, so the work is to productize it into a versioned, rate-limited public API, a small npm SDK, and a reference wallet hook, so any wallet or agent can request a pre-sign risk verdict in one call. This is what turns the project from an app into infrastructure for the agent loop. (1 to 2 days.)
- **Turn Claude explanations on in production.** Fund the Anthropic account. The integration is already wired and deployed, so this is the trivial step. (Hours.)
- **Richer program/IDL labeling plus a CPI call-tree view.** Resolve more programs to names and instruction shapes from IDLs, then render the inner-instruction tree as an actual tree instead of a flat list. (~3 days.)
- **Expanded heuristics and watchlist growth from citable public sources.** Add rules for more drain patterns, and grow the watchlist only from sources I can cite. (~3 days.)
- **Hardening.** Move the client-supplied `rpcUrl` passthrough from its baseline SSRF guard toward a production host allowlist, add rate limiting, and add persistence. (~3 days.)

Full deliverables and sequencing live in **`MILESTONES.md`**.

## 8. The ask & honest caveats

A modest ~200 USDG to take this from a live, tuned tool to a genuinely deep public service. The product already ships and is public. The grant funds the rest: turn on Claude in production, add program/IDL labeling and a CPI call-tree view, expand the registry and watchlist (only from citable sources), and harden the `rpcUrl` passthrough with rate limiting and an allowlist.

**Stated plainly.** Heuristics are best-effort signals, not guarantees. The watchlist is curated and non-exhaustive, not financial advice. Public RPC rate-limits and prunes old transactions, and the pre-sign path needs a custom RPC. The `rpcUrl` passthrough ships with a baseline SSRF guard, but a production allowlist is still recommended. There is no persistence yet. Always verify on a trusted block explorer before acting.

## 9. Links & contact

- **Live app:** https://solana-agentic-tx-reviewer.vercel.app
- **Repository:** https://github.com/plutohan/solana-agentic-tx-reviewer (public)
- **Roadmap:** see `MILESTONES.md` in this repo.
- **Deploy guide:** see `DEPLOY.md`.
- **Contact:** _<!-- CONTACT PLACEHOLDER: add name, email, X/Discord, and wallet for grant disbursement -->_

---

*This is a read-only tool. It analyzes and simulates transactions, but it never signs or sends them. Risk heuristics and the watchlist are best-effort signals, not security guarantees or financial advice.*
