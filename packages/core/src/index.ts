/**
 * @solana-tx-reviewer/core
 *
 * The zero-dependency, zero-network heart of the Solana Agentic Transaction
 * Reviewer: the shared transaction model, the program registry, an instruction
 * discriminator decoder, and the deterministic risk engine (`assessRisk`).
 *
 * Nothing here touches the network, a private key, or @solana/web3.js, so it runs
 * the same in Node, the browser, CI, and an agent runtime. Feed it a
 * `ParsedTransaction` and get back a `RiskReport`.
 */
export * from "./types";
export * from "./format";
export * from "./numbers";
export * from "./programs";
export * from "./watchlist";
export * from "./decode";
export * from "./heuristics";
