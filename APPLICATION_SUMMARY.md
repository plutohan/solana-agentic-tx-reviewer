# Solana Agentic Transaction Reviewer

**The review step an agent runs before it signs. A read-only tool that turns a raw Solana transaction into a plain-English explanation and a scored, auditable risk report, so a human (or an agent) understands what was signed, or is about to be.**

> Status: working proof-of-concept. Submitted for the Superteam Agentic Engineering micro-grant (~200 USDG, Solana Earn).

---

## 1. Agentic engineering, two ways at once

This project leads with the grant theme, agentic engineering, in both directions.

**Built *with* agents.** A multi-agent workflow scaffolded, documented, and adversarially reviewed the codebase. A research-agent discovery pass confirmed the on-chain program IDs in the registry. An adversarial-review pass de-risked the heuristics. It found a false-positive where a routine Jupiter swap read HIGH "fully drained" off a pool account, and we killed it. Agents brought the toolchain current (Node 24, Rust 1.96, Agave 4.0.1, Anchor 1.0.2) and wrote the regression suite that now guards every change. The build process is the demo. This is what agent-assisted engineering produces when you hold it to a verifiable bar.

**Built to *become* an agent.** Think of the reviewer as the review step in the agent loop. An agent proposes a transaction, the reviewer judges it (`parse → heuristics → explanation`), and a human or higher-level agent approves. An autonomous signer that can *act* without a structured, grounded way to *review* is a liability. That review step is the safety primitive Solana's agentic future is missing. The clean `fetch → parse() → assessRisk() → explainTransaction()` contract, exposed as a single `reviewTransaction()` call, is exactly the tool an agent needs to reason about a transaction with facts instead of hallucinations.

## 2. The problem: signing blind

Every day, Solana users and bots approve transactions they cannot read. Wallets render base58 keys you can't make sense of and a "confirm" button. Explorers render instruction data, account indexes, and CPI trees, but not "this hands control of your token account to a stranger." That gap is where drains live. Delegate approvals, `SetAuthority` handovers, and full token-account sweeps look normal in an explorer and are devastating in practice. The information is on-chain and public. It just isn't *explained*. As agents start holding keys, the gap scales with them.

## 3. What's built

A complete, runnable Next.js 16 (App Router) app. It is **read-only**. It never signs, never sends, never holds a key. It reviews a transaction two ways, and both paths run the exact same `parse → risk → explain` pipeline.

**Pre-sign simulation is shipped (`src/lib/presign.ts`). This is the headline feature, and it is built and verified live.** You can now review an **unsigned** transaction before approving it. The safety layer moved *before* the signature, which is the whole point of the agent-loop framing. The flow: accept a base64-serialized `VersionedTransaction`, deserialize it, resolve any address lookup tables (v0), then simulate read-only with `connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: 'base64', addresses: writableAccounts } })`. From there it derives SOL and SPL token deltas by diffing the pre-state (`getMultipleAccountsInfo`) against the simulated post-state (token amount is the u64 LE at byte 64, mint decimals come from the mint account at byte 44). It recovers SPL Token and System instruction *types* from the raw instruction data with a small discriminator decoder, so the same `parsedType`-dependent heuristics (`setAuthority`, `approve`, `closeAccount`, `createAccount`, and the rest) still fire. It emits the SAME `ParsedTransaction` the confirmed path produces (with `simulated: true`), so the risk engine, the explanation, and the UI are unchanged. I verified it live: an unsigned transfer to the burn/incinerator address simulated successfully, showed SOL deltas of -0.001005 (payer, fee included) and +0.001 (burn), and the `FLAGGED_ADDRESS` watchlist rule fired BEFORE signing. Nothing is ever signed or sent. Simulation only.

**Token metadata enrichment is shipped (`src/lib/metadata.ts`).** It resolves a mint to `{ symbol, name, logoURI }` via a small known-token registry (SOL, USDC, USDT, BONK, JUP, WIF, JTO) plus a cached, best-effort Jupiter datapi lookup (`https://datapi.jup.ag/v1/assets/search?query=<mint>`). It degrades gracefully to the raw mint when a token is unknown or the endpoint is unreachable. Token tables and the explanation now show "USDC" and a logo instead of a raw mint and a base-unit delta. `enrichTokenMetadata()` runs inside `reviewTransaction()` for BOTH paths, and it never throws.

**The confirmed-signature path.** You paste a signature. It fetches over Solana RPC (`getParsedTransaction`, `maxSupportedTransactionVersion: 0`), normalizes the result (SOL deltas, SPL token balance changes, flattened top-level **and** inner/CPI instructions, aggregated program invocations), runs deterministic heuristics, and produces a natural-language explanation plus a scored risk report. In `src/lib/`: `types.ts`, `solana.ts` (read-only RPC plus an SSRF guard on client-supplied URLs), `parse.ts`, `presign.ts`, `metadata.ts`, `programs.ts`, `heuristics.ts`, `watchlist.ts`, `ai.ts`, and `review.ts`, orchestrated behind `src/app/api/review/route.ts`.

**The API and the types carry both modes.** `ReviewRequest` now accepts `signature` or `rawTransaction` (exactly one). `POST /api/review` with `{ rawTransaction: <base64> }` triggers the pre-sign path. New type fields: `ReviewRequest.rawTransaction`, `ParsedTransaction.simulated`, and `TokenBalanceChange.symbol`/`name`/`logoURI`.

**The UI handles both paths.** The home page has a "Confirmed signature" / "Unsigned tx (pre-sign)" toggle, with a textarea for the base64 tx. `ResultView` shows token symbols, plus a "SIMULATED" badge and "Would succeed / Would fail" for the pre-sign path. The shareable permalink is shown only for confirmed reviews. The simulated explanation is framed plainly: "This is a read-only simulation of an unsigned transaction. If signed and sent now, it would..."

**Tuned, signer-scoped, swap-aware heuristics (18 rules, up from 16).** I hardened the engine in `heuristics.ts` against the false positives that plague naive scanners:

- **Signer-scoped drains.** `FULL_TOKEN_ACCOUNT_DRAIN` and `LARGE_TOKEN_OUTFLOW` now fire **only on signer-owned token accounts**. Pool/vault accounts (owned by program PDAs) routinely zero out during a swap, so we ignore them. That was the single biggest source of false alarms.
- **Wrapped SOL excluded.** `So111…112` (WSOL) is transient by design. The native-SOL rules already cover it, so it no longer trips token-drain logic.
- **New `TOKEN_SWAP` rule (low).** When a would-be drain coincides with the **same signer receiving value back** (a different-mint token inflow above one base unit, or net SOL) **and** a known DEX program is present, we *relabel* the finding a swap rather than clear it. Dusted fake inflows and undefined owners fail safe to the higher-risk finding. Known venues (`isDexProgram`) include Jupiter v4/v6, Raydium v4/CLMM/CPMM, Orca Whirlpools, Meteora DLMM/DAMM v2, Phoenix, Lifinity v2, PumpSwap AMM, and pump.fun.
- **New `FLAGGED_ADDRESS` rule** backed by `watchlist.ts`, a curated, **best-effort, non-exhaustive, not-financial-advice** list. I seeded it honestly with the known SOL burn/incinerator address (program-ID matching is wired but empty by default to avoid false accusations).
- **De-saturated scoring.** `assessRisk()` dedups same-id findings (merging evidence, tagging `×N`) and applies **diminishing returns** (`weight × 0.5^k` for the *k*-th finding at a level). Level weights are unchanged (`info 0 / low 10 / medium 25 / high 45`). The result: a routine swap reads LOW while a real, *stacked* drainer stays HIGH.

Every finding carries human-readable evidence. These are explainable **signals, not verdicts**.

**A real, dual-provider LLM behind a free-by-default seam.** `ai.ts` genuinely calls **Anthropic or OpenAI** (selected by `AI_PROVIDER`, with `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` or `OPENAI_API_KEY`/`OPENAI_MODEL`). The Anthropic path uses prompt caching on the static system prompt. With no key set, it returns a deterministic, template-based placeholder. **Zero keys, zero cost, always works.** **Any** error (missing key, network, rate limit, bad JSON) degrades gracefully to that placeholder. Configure a key and the "agentic" claim is substantiated. Skip it and the PoC stays honest and self-contained.

**A shareable permalink with an OG risk card.** `GET /tx/<signature>?cluster=…` (`src/app/tx/[signature]/page.tsx`) server-renders the full `reviewTransaction` pipeline, reusing `ResultView` with zero new risk logic. A Next 16 `ImageResponse` OG card (`opengraph-image.tsx`) shows risk level plus score plus a short signature, so a pasted link unfurls into a risk preview (`metadataBase` comes from `NEXT_PUBLIC_SITE_URL`). The home page links straight to it via "Open shareable permalink."

**A passing regression suite.** `npm test` runs `tests/heuristics.test.ts` via `tsx`. That is 24 deterministic checks proving: a sell-via-DEX becomes `TOKEN_SWAP` (not HIGH, score < 25), a real drain is HIGH (score ≥ 45), pool and WSOL noise is filtered, and the watchlist fires. All pass. Pre-sign simulation and metadata enrichment need a live RPC, so they are not in the offline unit suite. I verified them by live integration against mainnet instead. The project is a git repo with a baseline and an enhancement history.

**Toolchain (current):** Node.js 24.16.0 LTS, Next.js 16.2.7, React 19.2.7, TypeScript 6, Tailwind CSS 4.3.0 (CSS-first), `@solana/web3.js` 1.98.4. Agents updated the broader machine toolchain (Rust 1.96.0, Agave/Solana CLI 4.0.1, Anchor 1.0.2), though this web app does not use it.

## 4. Honest limitations of the pre-sign path

The pre-sign path is real, but it is not magic, and I want to be precise about its edges. The fee is not computed during simulation, so it is shown as not-applicable. The instruction-type decoder covers SPL Token and System. Other programs' instruction types are not decoded, though the balance, program, and watchlist heuristics still apply. It needs a custom RPC, because public RPC rate-limits simulate-with-accounts. And because the blockhash is replaced, the real result after signing can differ if on-chain state changes before you submit.

## 5. Roadmap: what's next

Pre-sign simulation and token metadata enrichment are both done. They are no longer promises in this section. The remaining milestones build on top of them. Estimates are in days, at agent pace.

- **Deepen the LLM guardrails.** Tighten the prompt contract, add structured output validation, and stress-test the explanation against adversarial transactions so it can't be talked into a wrong summary. (~2 days.)
- **Richer program/IDL labeling plus a CPI tree view.** Resolve more programs to names and instruction shapes from IDLs, then render the inner-instruction tree as an actual tree instead of a flat list. (~3 days.)
- **Expanded heuristics, watchlist growth, and hardening.** Add rules for more drain patterns, grow the watchlist only from citable sources, and move the client-supplied `rpcUrl` passthrough from its baseline SSRF guard toward a production allowlist. (~3 days.)

Full deliverables and sequencing live in **`MILESTONES.md`**.

## 6. The ask & honest caveats

A modest ~200 USDG to take this from a tuned PoC to a genuinely useful public tool. Pre-sign simulation already ships. The grant funds the rest: deepen LLM coverage and guardrails, add program/IDL labeling and a CPI tree view, expand the program registry and watchlist (only from citable sources), and harden the client-supplied `rpcUrl` passthrough toward a production allowlist.

**Stated plainly:** heuristics are best-effort signals, not guarantees. The watchlist is curated and non-exhaustive, not financial advice. Public RPC rate-limits and prunes old transactions (a custom RPC is supported, and the pre-sign path needs one). The `rpcUrl` passthrough ships with a baseline SSRF guard, but a production allowlist is still recommended. There is no persistence. Always verify on a trusted block explorer before acting.

## 7. Links & contact

- **Repository:** https://github.com/plutohan/solana-agentic-tx-reviewer (public)
- **Roadmap:** see `MILESTONES.md` in this repo.
- **Contact:** _<!-- CONTACT PLACEHOLDER: add name, email, X/Discord, and wallet for grant disbursement -->_

---

*This is a read-only proof-of-concept. It analyzes and simulates transactions, but it never signs or sends them. Risk heuristics and the watchlist are best-effort signals, not security guarantees or financial advice.*
