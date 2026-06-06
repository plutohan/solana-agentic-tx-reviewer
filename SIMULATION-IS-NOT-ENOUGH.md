# Simulation Is Not Enough

### What static instruction-level review catches on real Solana drains, and what it honestly does not

Wallets and agents mostly decide what is safe to sign by *simulating* a transaction and showing you the balance changes. That catches a lot. It also misses a whole class of attacks, because the dangerous part of a transaction is not always a balance change.

So I took four **real, documented** Solana incidents and ran the actual on-chain transactions through a deterministic, read-only reviewer ([live demo](https://solana-agentic-tx-reviewer.vercel.app/incidents)). No LLM in the decision. Every verdict below is reproducible: open the permalink, or `POST /api/v1/review` with the same signature, and you get the same answer.

The reviewer is deliberately structured so an LLM (or anything else) can only make it *more* cautious, never less. The deterministic engine plus a circuit breaker (`ALLOW / WARN / REQUIRE_HUMAN`, keyed on irreversibility) is the floor.

---

## Caught before signing

**SlowMist wallet owner-permission hijack (~$3M, Nov 2025).** A System `assign` silently reassigns the victim's own account owner to the attacker, plus two unlimited token approvals. A balance-diff simulation shows *no fund movement*, so it looks safe. The reviewer flags it **HIGH (93/100)**: `ACCOUNT_REASSIGN` + unlimited `TOKEN_DELEGATE_APPROVE`, both irreversible, so the circuit breaker returns `REQUIRE_HUMAN`. The exact signature and both addresses are named in SlowMist's own post-mortem.

**PYTH address-poisoning (~$2.91M, Nov 2024).** The victim sent ~7M PYTH to a lookalike "poison" address that mimics the real recipient. Flagged **HIGH** as a full-balance outflow, enough to make you stop. Honest limit: the reviewer flags the *magnitude*, not the address resemblance itself; catching the lookalike needs cross-transaction history the engine does not hold.

**Vanish drainer, TOCTOU bit-flip (Blockaid-documented).** The signed transaction simulates benign, then the attacker flips on-chain state a few blocks later so execution sweeps the wallet through an opaque program. This is the textbook case simulation cannot see. The realized drain is flagged **HIGH**, and before signing, the opaque attacker program alone returns `REQUIRE_HUMAN`: do not auto-sign what you cannot inspect.

---

## Where it does not help (the honest part)

**Drift Protocol exploit (~$285M, Apr 2026).** I expected to "catch" this. I do not, and saying otherwise would be dishonest. The damaging transaction was a *valid* Squads multisig governance action, and the privilege handover was a Drift-specific `UpdateAdmin` CPI, not a System or SPL instruction the engine decodes. The reviewer raises only a low durable-nonce note plus "unknown program" (**MEDIUM, 35/100**). The root cause was a six-month social-engineering and device-compromise operation that got real signers to pre-sign via durable nonces. That is upstream of any transaction reviewer.

What *would* have helped is narrow and specific: per-program admin-change decoding (so a Drift `UpdateAdmin` reads as an admin handover even inside a multisig). That is a roadmap item, not a claim.

---

## The point

No single layer is enough. Simulation, wallet policy engines (Turnkey, Privy), Solana's native spending limits, and static instruction-level review each catch a different slice. Static review is the underrated one: it is deterministic, auditable, runs offline, and catches owner-reassignment, unlimited approvals, and opaque-program interactions that a balance-diff preview shows as "nothing happening." In a catalog of 90 documented Solana attack techniques, **67 are not fully detectable by simulation alone.**

It is also the layer most prone to overclaiming. So: here are the real transactions, the real verdicts, and the one that got away. Check them yourself.

- Demo: https://solana-agentic-tx-reviewer.vercel.app/incidents
- Code, the 23-rule engine, the circuit breaker, and the 90-attack database: https://github.com/plutohan/solana-agentic-tx-reviewer

Built end-to-end with multi-agent workflows, including the adversarial reviews that killed the overclaims.
