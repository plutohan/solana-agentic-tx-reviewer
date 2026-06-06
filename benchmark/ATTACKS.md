# Solana transaction attack database

A source-verified database of **90** real-world Solana transaction attack techniques and incidents, built to drive the risk rules, the benchmark fixtures, and the circuit breaker (`decide`). Each entry records whether a pre-sign simulation catches it, whether the action is irreversible (blast radius), and which of our rules covers it or `GAP`. Machine-readable: [`attacks.json`](attacks.json).

**Coverage vs our rules:** covered 25 · partial 27 · gap 38.  
**Simulation-detectable:** yes 23 · partial 42 · no 25 — the `no`/`partial` cases are exactly why static instruction-level review matters.  
**Severity:** high 40 · critical 36 · medium 13 · low 1

## Summary
Of 80 mapped attack entries, roughly 28 are fully covered by existing rules (the authority-handover family via SET_AUTHORITY/ACCOUNT_REASSIGN/TOKEN_DELEGATE_APPROVE, multi-asset sweeps via FULL_TOKEN_ACCOUNT_DRAIN/LARGE_SOL_OUTFLOW, and closeAccount via CLOSE_TOKEN_ACCOUNT), about 22 are partial (the rule fires but at the wrong severity or misses the load-bearing nuance — e.g. UNKNOWN_PROGRAM fires for TOCTOU/bit-flip but cannot reveal post-sign state mutation, and zero-balance-diff authority handovers can be naively downgraded), and about 30 are outright gaps. The standout finding is that the entire highest-loss real-world class — durable-nonce pre-signed/delayed execution (Drift ~$285M, plus 14 documented phishing txns) — has NO existing rule despite the AdvanceNonceAccount-at-index-0 marker being trivially keyable; the second standout is that two whole modern attack surfaces (system-account/vanity-address impersonation + address poisoning, and the full Token-2022 extension family: permanent delegate, transfer hook, default-frozen, transfer fee, confidential transfer, non-transferable, mint-close-reinit) are entirely uncovered. A cross-cutting weakness is that several critical drains (TOCTOU bit-flip, fake-simulation switch, Slope/DEXX/web3.js key leaks) are simulationDetectable=no and require reviewer logic beyond naive value-diff simulation.

## Top gaps to close first

- DURABLE_NONCE: add DURABLE_NONCE_PRESENT (AdvanceNonceAccount at instruction index 0 / recent_blockhash == stored nonce) and escalate DURABLE_NONCE_WITH_PRIVILEGED_IX when paired with SetAuthority/Assign/UpgradeProgram/admin/vaultTransactionExecute — covers Drift ~$285M and all sign-now/drain-later phishing; currently a complete GAP.
- Owner/authority-handover-as-CRITICAL regardless of zero balance diff: add ZERO_BALANCE_DIFF_AUTHORITY_HANDOVER so Assign/SetAuthority(AccountOwner) are never downgraded by naive value-diff simulation (this is the single highest-loss SolPhish class, $812,219.75 / 73.85%).
- System-account & vanity-address impersonation + address poisoning: add SYSTEM_ACCOUNT_IMPERSONATION (regex /Compu.*/, /.*1111/ + full-string compare vs canonical program IDs) and LOOKALIKE_RECIPIENT (head/tail + Levenshtein vs the user's historical recipients, plus DUST_SEED_HISTORY) — covers the $2.91M PYTH case, ISA, and all dust poisoning; currently entirely uncovered.
- Token-2022 extension scan at swap/acquire time: add TOKEN2022_EXTENSION_SCAN parsing the mint TLV for PermanentDelegate (type 12), TransferHook (type 14), DefaultAccountState=Frozen (type 6), TransferFee (type 1), ConfidentialTransfer, NonTransferable (type 9), and MintCloseAuthority (type 3) — a whole modern rug/honeypot surface with no current coverage.
- Address Lookup Table resolution: add ALT_RESOLUTION_REQUIRED to fully expand every v0 addressTableLookups before any other rule runs, and flag programs/recipients that appear only via a recently-created/extended ALT — without this, every other rule can be blinded by ALT obfuscation.
- TOCTOU / simulation-evasion hardening: add TOCTOU_STATE_GATED_UNKNOWN_PROGRAM + WRITABLE_SCOPE_VS_SIM_EFFECT_MISMATCH + SIM_INFLOW_BUT_WRITABLE_TO_FOREIGN, and a SIM_FAILED_BUT_MUTATING rule so a failed/fabricated simulation never downgrades a mutating tx; also re-simulate against a trusted RPC rather than trusting dApp-provided previews.
- Signer/fee-payer vs value-destination mismatch and third-party submission: flag when the fee-payer/signer is the victim while value flows to an unrelated destination, and when the tx submitter != signer (relayer/durable-nonce) — a shared tell across Blinks payloads, TOCTOU, and pre-signed drains.
- Behavioral sweep heuristics for key-leak drains (Slope/DEXX/web3.js): since those txns are legitimately owner-signed and simulationDetectable=no, add BEHAVIORAL_SWEEP_HEURISTIC (sudden full-balance sweep to a fresh/never-paid recipient) + FLAGGED_ADDRESS on known exfil/consolidation clusters as a soft warning layer.

## Attacks by category

### Account authority takeover

#### System Program `assign` wallet-owner reassignment (AAT)
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `ACCOUNT_REASSIGN`)
- **Mechanism:** Victim signs a System Program `assign` (discriminator 1) that rewrites the owner field of their own signer account from the System Program to an attacker phishing program; the attacker's program then drains via CPI. AssignWithSeed discriminator is 10 (not 12).
- **On-chain signature:** Top-level/CPI System Program (1111...1111) instruction with discriminator 1 (Assign) or 10 (AssignWithSeed) where the assigned account is a signer/fee-payer/user wallet and the new owner is not a well-known program.
- **Real incidents:** SlowMist Dec 4 2025: victim 9w2e3kpt5XUQXLdGb51nRWZoh4JFs6FL7TdEYsvKq6Wb owner reassigned to GKJBELftW5Rjg24wP88NRaKGsEBtrPLgMiv3DhbJwbzQ, ~$3M + ~$2M locked; SolPhishHunter (arXiv:2505.04094): AAT class, 2,272 suspicious authority-transfer txns (2,171 confirmed), top program BNRT...5Rep 931 txns, $812,219.75 (73.85% of losses)
- **Benchmark fixture:** Tx with System assign re-owning the fee-payer's own account to an unknown program; expect ACCOUNT_REASSIGN=critical.
- **Sources:** https://slowmist.medium.com/beware-of-solana-phishing-attacks-wallet-owner-permissions-may-be-altered-708bbb30518e, https://arxiv.org/html/2505.04094v1, https://arxiv.org/abs/2505.04094

#### SPL Token `SetAuthority` AccountOwner handover
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `SET_AUTHORITY`)
- **Mechanism:** Victim signs SPL Token SetAuthority (tag 6) with authorityType=AccountOwner (byte 2) reassigning their token account/ATA to the attacker, who then sweeps the full balance with no further approval.
- **On-chain signature:** Token (Tokenkeg...) or Token-2022 (Tokenz...) instruction tag 6 (SetAuthority), authority_type byte = 2 (AccountOwner), target is a user-owned token account/ATA and new authority != user.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): SetAuthorityIns authorityType=='account owner'; AAT $812,219.75, avg $374.12/txn, single largest $751,880.51; Liminal Custody (2026): SPL Token Account Ownership Reassignment; two low-value probes neutralized Feb 2026
- **Benchmark fixture:** Tx with SetAuthority(AccountOwner) handing a user ATA to a fresh address; expect SET_AUTHORITY=critical.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://www.liminalcustody.com/blog/how-the-solana-false-top-up-attack-works-and-how-to-stop-it/, https://slowmist.medium.com/beware-of-solana-phishing-attacks-wallet-owner-permissions-may-be-altered-708bbb30518e

#### SPL `SetAuthority` MintTokens / FreezeAccount handover
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **partial** → suggest: SET_AUTHORITY_MINT_OR_FREEZE: distinguish mint-vs-token-account targets; flag any SetAuthority moving MintTokens/FreezeAccount authority off a project multisig as high, and FreezeAccount calls by a non-owner authority.
- **Mechanism:** SetAuthority on a MINT with authorityType=MintTokens (0) or FreezeAccount (1) hands the attacker infinite-mint or freeze-all power. SolRugDetector classes Freeze Authority Abuse as a rug-pull method.
- **On-chain signature:** Token/Token-2022 SetAuthority (tag 6) with authority_type = 0 (MintTokens) or 1 (FreezeAccount) on a mint the user/project controls, new authority attacker-controlled; or a later FreezeAccount call by a non-project authority.
- **Real incidents:** SolRugDetector (arXiv:2603.24625): Freeze Authority Abuse as one of three Solana rug-pull methods; SolPhishHunter (arXiv:2505.04094): SetAuthority as authority-handover primitive in AAT
- **Benchmark fixture:** Tx with SetAuthority(FreezeAccount) on a mint to a fresh address; expect SET_AUTHORITY=high (mint/freeze variant).
- **Sources:** https://arxiv.org/pdf/2603.24625, https://arxiv.org/html/2505.04094v1, https://dev.to/carson2222/how-to-secure-a-solana-tokens-nfts-updating-and-revoking-authorities-25gb

#### SPL SetAuthority mint hijack & freeze-rug (variant)
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **partial** → suggest: See SET_AUTHORITY_MINT_OR_FREEZE.
- **Mechanism:** Duplicate-class mint/freeze authority handover (see spl-setauthority-mint-freeze-authority-rug).
- **On-chain signature:** SetAuthority tag 6 with authority_type 0/1 on a mint to attacker.
- **Real incidents:** SolRugDetector (arXiv:2603.24625) Freeze Authority Abuse
- **Benchmark fixture:** Tx SetAuthority(MintTokens) on a mint; expect SET_AUTHORITY=high.
- **Sources:** https://arxiv.org/pdf/2603.24625

### Account authority takeover (attribution abuse)

#### False top-up via `setAuthority` ownership reassignment
`medium` · sim-detectable: **yes** · irreversible: **False** · coverage: **partial** → suggest: INTRA_TX_SETAUTHORITY_WITH_WASH_TRANSFER: flag a SetAuthority(AccountOwner) co-occurring with in+out transfers netting ~zero on the same just-created account; for indexers, require net balance increase + deterministic ATA validation before crediting.
- **Mechanism:** Atomic tx creates an attacker-owned token account, runs a net-zero wash transfer, then SetAuthority reassigns ownership to a victim deposit address; indexers reading ownership post-finalization mis-credit a deposit. Attribution manipulation, not direct theft.
- **On-chain signature:** Single tx with InitializeAccount + Transfer in/out (net zero) + SetAuthority(AccountOwner) reassigning a just-created token account to a known platform deposit address.
- **Real incidents:** Liminal Custody (Feb 2026): two low-value false top-up probes detected/neutralized; no customer funds affected
- **Benchmark fixture:** Single tx: create ATA, transfer in/out net-zero, SetAuthority to a deposit address; expect SET_AUTHORITY + false-top-up flag.
- **Sources:** https://www.liminalcustody.com/blog/how-the-solana-false-top-up-attack-works-and-how-to-stop-it/

### Account/authority hijack drain

#### AAT: Account Authority Transfer via SetAuthority / Assign
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `SET_AUTHORITY`)
- **Mechanism:** Reassign ownership/authority instead of moving funds: SPL SetAuthority hands AccountOwner/CloseAuthority of a token account; System Assign changes the program-owner of a signer's account.
- **On-chain signature:** SetAuthority (index 6) setting AccountOwner/CloseAuthority to a non-owner, or System Assign reassigning a signer-owned account to a non-system program.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): AAT among three SolPhish types, part of 8,058 instances / ~$1.1M; Aqua/Vanish + drainer kits use SetAuthority/Assign (mis-attributed; bit-flip is the actual Aqua/Vanish behavior)
- **Benchmark fixture:** Tx with both Assign (wallet) and SetAuthority(AccountOwner) (ATA) to attacker; expect ACCOUNT_REASSIGN + SET_AUTHORITY=critical.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://cointelegraph.com/news/scam-as-a-service-new-solana-drainers-identified, https://bitcoinworld.co.in/blowfish-detected-new-aqua-vanish-transaction-drainers-on-solana-sol/

### Account/intent obfuscation

#### Address Lookup Table (ALT) account obfuscation
`high` · sim-detectable: **yes** · irreversible: **True** · coverage: **gap** → suggest: ALT_RESOLUTION_REQUIRED: for v0 txns, fully resolve every ALT before applying any other rule; flag programs/recipients that appear only via ALT, recently-created/extended ALTs, and non-deactivated ALT authorities.
- **Mechanism:** v0 txns reference accounts by 1-byte indexes into an on-chain ALT; a surface that doesn't resolve the ALT hides the real writable/program accounts (including attacker-extended ones). Real ALT program id is AddressLookupTab1e1111111111111111111111111.
- **On-chain signature:** v0 message with non-empty addressTableLookups; load each ALT (owner=AddressLookupTab1e...) and expand writable/readonly indexes before judging. Flag program IDs/recipients existing ONLY in ALT-resolved accounts and recently-created/extended ALTs.
- **Real incidents:** ALT/versioned txns activated mainnet 2022-10-10; Hardware-wallet inability to display ALT-referenced accounts (standing limitation 2024-2026)
- **Benchmark fixture:** v0 tx whose drain recipient exists only in a recently-extended ALT; expect ALT_RESOLUTION_REQUIRED + downstream rule firing on the resolved recipient.
- **Sources:** https://solana.com/developers/guides/advanced/lookup-tables, https://docs.anza.xyz/proposals/versioned-transactions, https://docs.phantom.com/developer-powertools/solana-versioned-transactions

#### Intra-transaction SetAuthority 'false top-up'
`high` · sim-detectable: **partial** · irreversible: **False** · coverage: **partial** → suggest: INTRA_TX_SETAUTHORITY_WITH_WASH_TRANSFER (shared): validate owner at transfer time, not only post-finalization; flag SetAuthority co-occurring with transfers on the same account.
- **Mechanism:** Within one tx: create attacker-owned token account, net-zero wash transfer, then SetAuthority reassigning ownership to a victim/exchange deposit address; post-finalization indexers mis-credit a deposit.
- **On-chain signature:** Single tx with a SetAuthority(AccountOwner) targeting a token account that also appears in a Transfer in the same tx; net token balance change ~0 but final owner != transfer-time owner.
- **Real incidents:** Liminal Custody: intra-tx setAuthority ownership reassignment after wash transfer (2025/Feb 2026)
- **Benchmark fixture:** Single tx with Transfer + SetAuthority on the same account, net-zero; expect SET_AUTHORITY + false-top-up flag.
- **Sources:** https://www.liminalcustody.com/blog/how-the-solana-false-top-up-attack-works-and-how-to-stop-it/

### Address impersonation / poisoning

#### Vanity-address system-account impersonation (ISA / address poisoning)
`medium` · sim-detectable: **no** · irreversible: **True** · coverage: **gap** → suggest: LOOKALIKE_RECIPIENT + SYSTEM_ACCOUNT_IMPERSONATION (shared).
- **Mechanism:** Grind vanity addresses resembling system/program addresses or frequent counterparties; seed history with tiny transfers; victim copies the wrong address and signs a normal transfer to the attacker.
- **On-chain signature:** Ordinary System/SPL transfer whose destination is a vanity address resembling a known good address (shared prefix/suffix) but not equal; often preceded by dust from that lookalike. Key on near-collision with whitelisted addresses and dusting precursors.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): ISA $75,701.98, Jan-Jun 2024; 'Compu' prefix / '1111' suffix
- **Benchmark fixture:** Transfer to a near-collision vanity recipient with a dust precursor; expect LOOKALIKE_RECIPIENT=medium.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://arxiv.org/pdf/2505.04094

### Address poisoning

#### Fake system-program / vanity-address poisoning (ISA)
`medium` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: LOOKALIKE_RECIPIENT / SYSTEM_ACCOUNT_IMPERSONATION: full-string compare recipient against canonical program IDs and the user's verified contacts; flag near-duplicates (shared head/tail, different middle) and dust precursors.
- **Mechanism:** solana-keygen grind vanity addresses sharing a prefix/suffix with system/program accounts; seed victim history with dust, then victim copies the poisoned address. SolPhishHunter ISA class.
- **On-chain signature:** Destination visually similar (prefix/suffix) to a known system/program address or prior counterparty but distinct; preceded by dust inbound transfers. Compare against canonical-program-ID and contact allowlist.
- **Real incidents:** Scam Sniffer (Feb 3 2024): addresses with same suffix as System Program; SolPhishHunter (arXiv:2505.04094): ISA class, $75,701.98
- **Benchmark fixture:** Transfer to a '...1111'-suffixed non-canonical address resembling the System Program; expect LOOKALIKE_RECIPIENT=medium.
- **Sources:** https://arxiv.org/abs/2505.04094, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676

#### Address poisoning via zero/dust transfers and memo airdrop links
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: LOOKALIKE_RECIPIENT + DUST_SEED_HISTORY (shared); also flag MEMO_PRESENT with airdrop/phishing-link patterns on inbound dust.
- **Mechanism:** Seed victim history with a lookalike address via 0-value/dust transfer (sometimes a phishing memo); victim later copies the poisoned address and sends real funds. The loss tx is a normal victim-initiated transfer.
- **On-chain signature:** A legit-looking Transfer whose destination is a near-match (same prefix+suffix) of a recently-poisoning counterparty; preceded by 0/dust inbound from a vanity-similar address.
- **Real incidents:** Scam Sniffer (Dec 2024): two victims lost 272 SOL; same fraudster >$3.1M in a month; $2.91M loss reported Nov 25 2024; GoPlus 'Address Poisoning' (zero/small transfer + memo variants)
- **Benchmark fixture:** Outbound transfer to a near-match of a prior counterparty seeded by a memo dust tx; expect LOOKALIKE_RECIPIENT=high.
- **Sources:** https://www.chaincatcher.com/en/article/2157079, https://www.the-blockchain.com/2024/11/25/solana-user-losses-2-91million-in-an-address-poisoning-scam-are-these-scams-becoming-a-nightmare-for-crypto-users/, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676

### Address spoofing

#### System-account impersonation via vanity look-alike addresses
`medium` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: SYSTEM_ACCOUNT_IMPERSONATION (shared): full-string compare against canonical addresses; never compare truncated forms.
- **Mechanism:** Vanity addresses mimicking system programs (trailing '1111', 'Compu...'); truncated UIs pass the glance check. SolPhishHunter ISA: 3,449 txs, $75,701.98. Overlaps with address-poisoning.
- **On-chain signature:** Account whose pubkey resembles a known program ID by truncated prefix/suffix but does not byte-equal the canonical address; full-string compare every program ID and recipient against an allowlist.
- **Real incidents:** Scam Sniffer (2024-02-03) system-program look-alike; SolPhishHunter (arXiv:2505.04094): 3,449 ISA txs, $75,701.98; Address Poisoning study (arXiv:2501.16681): 252M+ poisoning transfers (Ethereum/BSC, not Solana)
- **Benchmark fixture:** Transfer to a '...1111' lookalike of System Program; expect SYSTEM_ACCOUNT_IMPERSONATION=medium.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://arxiv.org/html/2501.16681v1, https://www.bitget.com/news/detail/12560604131179

### Address-spoofing transfer drain

#### ISA: Impersonation of System Account (lookalike-address sweep)
`medium` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: LOOKALIKE_RECIPIENT (shared): flag destination not in trusted set and base58-similar to a known counterparty/system account.
- **Mechanism:** Vanity/lookalike destination addresses resembling system/known accounts so the user approves transfers to the attacker; often combined with STMT and dust-seeding.
- **On-chain signature:** Transfer destination is a freshly-seen address visually similar to one in recent history or a well-known system/program address with no prior relationship.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): ISA one of three SolPhish types; part of 8,058 instances / ~$1.1M / 93.96% precision
- **Benchmark fixture:** Transfer to a lookalike of a recent counterparty; expect LOOKALIKE_RECIPIENT=medium.
- **Sources:** https://arxiv.org/abs/2505.04094, https://arxiv.org/html/2505.04094v1

### Anti-simulation / UI deception

#### Approval Crasher (fake 'Simulation Error')
`high` · sim-detectable: **no** · irreversible: **False** · coverage: **gap** → suggest: SIM_FAILED_BUT_MUTATING: when simulation errors/returns empty yet the decoded message still contains Approve/SetAuthority/Assign/Transfer/Burn, do NOT downgrade — treat as high-risk; also flag oversized/merged instruction sets and non-default RPC.
- **Mechanism:** Drainer deliberately crashes the wallet's pre-sign simulation so it shows a generic error; the user signs blind while the tx still contains malicious Approve/SetAuthority/Transfer. Bundled with Fake Gain/Fake Return modules.
- **On-chain signature:** No distinctive instruction; meta-signal: simulation returns error/empty while the tx contains state-changing token instructions. Often paired with merged/oversized instruction sets or non-default RPC.
- **Real incidents:** Scam Sniffer (Feb 3 2024): Crasher/anti-simulation modules + fake-system-program poisoning; GoPlus (Aug 30 2024): Anti-Simulation and Fake Simulation techniques
- **Benchmark fixture:** Tx whose simulation errors but message contains SetAuthority+Transfer; expect SIM_FAILED_BUT_MUTATING=high.
- **Sources:** https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676, https://drops.scamsniffer.io/over-4-million-stolen-by-multiple-solana-wallet-drainers/, https://cointrenches.io/solana-security-guide-2026/

### Anti-simulation / environment fingerprinting

#### Simulation-context detection via Incinerator / SlotHistory introspection
`high` · sim-detectable: **no** · irreversible: **True** · coverage: **gap** → suggest: SIM_FINGERPRINT_ACCOUNTS: flag any tx passing the Incinerator account or SlotHistory/SlotHashes sysvar to a non-system program with no functional need.
- **Mechanism:** Program fingerprints simulation vs live by reading the Incinerator account (~85%) or SlotHistory sysvar (~25%); returns benign in sim, drains live. Mitigated by Anza PR #24543.
- **On-chain signature:** Program reads the Incinerator (1nc1nerator11111111111111111111111111111111) or SlotHistory sysvar (SysvarS1otHistory11111111111111111111111111) with no functional reason; instruction-introspection via the Instructions sysvar.
- **Real incidents:** OPCODES 'Detecting simulation in a Solana program' (Jan 2022): Incinerator ~85% / SlotHistory ~25%; Mitigation: solana-labs PR #24543 (joncinque)
- **Benchmark fixture:** Tx passing the Incinerator account to an unknown program; expect SIM_FINGERPRINT_ACCOUNTS=high.
- **Sources:** https://opcodes.fr/publications/2022-01/detecting-transaction-simulation, https://github.com/solana-labs/solana/pull/24543

### Authority hijack hidden as benign signature

#### SystemProgram Assign / SetAuthority account-owner reassignment
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `ACCOUNT_REASSIGN`)
- **Mechanism:** Solana's mutable Owner field: victim signs System Assign (re-owns a wallet to attacker program) and/or SetAuthority(AccountOwner) (re-owns a token account); no tokens move so balance-diff sim looks benign. AAT = $812,219.75 (73.85%).
- **On-chain signature:** System Assign re-owning a signer's account, or SetAuthority authorityType=AccountOwner on a signer-owned account; net token balance change can be ZERO — the danger is the owner field.
- **Real incidents:** SlowMist (2025-12-04): wallet owner reassigned, unable to move funds; SolPhishHunter (arXiv:2505.04094): 2,171 AAT txs, $812,219.75 (73.85%); Rainbow/Node Drainer: 3,947 victims, $4.17M+ (Jan 2024)
- **Benchmark fixture:** Tx with Assign + decoy transfer, net token diff zero; expect ACCOUNT_REASSIGN=critical despite zero diff.
- **Sources:** https://slowmist.medium.com/beware-of-solana-phishing-attacks-wallet-owner-permissions-may-be-altered-708bbb30518e, https://arxiv.org/html/2505.04094v1, https://drops.scamsniffer.io/over-4-million-stolen-by-multiple-solana-wallet-drainers/

### Authority transfer / account takeover (AAT)

#### SPL Token SetAuthority (AccountOwner) phishing takeover
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `SET_AUTHORITY`)
- **Mechanism:** Phishing dApp prompts SetAuthority authorityType=AccountOwner reassigning the victim's token account to the attacker in a single instruction (no two-step approve). AAT = 73.85% of measured losses.
- **On-chain signature:** SPL Token (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA) SetAuthority with AuthorityType=AccountOwner (or CloseAuthority), new authority != signer; native variant System Assign.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): AAT $812,219.75, dominant class, Jan-Jun 2024; Rainbow/Node Drainer (Scam Sniffer): ~$4.17M / ~3,947 victims
- **Benchmark fixture:** Tx SetAuthority(AccountOwner) on a user ATA to attacker; expect SET_AUTHORITY=critical.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://arxiv.org/pdf/2505.04094, https://coinpedia.org/news/solana-wallets-caught-in-a-phishing-signature-attacks/, https://www.cryptopolitan.com/growing-concerns-over-solana/

### Authority/ownership theft

#### SetAuthority AccountOwner reassignment (token-account ownership theft)
`critical` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `SET_AUTHORITY`)
- **Mechanism:** Victim signs SetAuthority authorityType=AccountOwner (2) reassigning their token account to the attacker; cannot revoke since no longer owner. AAT was the most lucrative SolPhish class.
- **On-chain signature:** SetAuthority (tag 6) where authority_type is AccountOwner (or CloseAccount/FreezeAccount) and new_authority is an unknown external pubkey on an account the signer owns.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): AAT largest loss category $812,219.75 of ~$1.1M; GoPlus (Aug 30 2024): createSetAuthorityInstruction owner-change drainers
- **Benchmark fixture:** Tx with SetAuthority(AccountOwner) on a user ATA to an unknown pubkey; expect SET_AUTHORITY=critical.
- **Sources:** https://arxiv.org/abs/2505.04094, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676

### Authority/ownership transfer drain

#### Account owner reassignment via SystemProgram Assign (full takeover)
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `ACCOUNT_REASSIGN`)
- **Mechanism:** System Assign reassigns the program-owner of the victim's account to an attacker program; the attacker's program then moves lamports/data on its own schedule. Pairs with durable nonce.
- **On-chain signature:** System Assign targeting a user-owned account, changing owner to a non-System/non-Token program the user doesn't control; assignee program unknown/attacker-controlled; signer is the account being reassigned.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): AAT via Assign; part of 8,058 txns / ~$1.1M
- **Benchmark fixture:** Tx with System Assign re-owning the signer account to an unknown program; expect ACCOUNT_REASSIGN=critical.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://arxiv.org/abs/2505.04094

#### Token-account authority theft via SetAuthority
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `SET_AUTHORITY`)
- **Mechanism:** SetAuthority (createSetAuthorityInstruction) changes AccountOwner/CloseAccount/mint authority of the victim's token account to the attacker; deferrable via durable nonce.
- **On-chain signature:** SetAuthority with authorityType AccountOwner/CloseAccount/MintTokens where new authority != signer; high-risk when combined with advanceNonce or batched with transfers.
- **Real incidents:** GoPlus: createSetAuthorityInstruction token-account owner reassignment; SolPhishHunter (arXiv:2505.04094): AAT for token accounts
- **Benchmark fixture:** Tx with SetAuthority(AccountOwner) on a user ATA; expect SET_AUTHORITY=critical.
- **Sources:** https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676, https://arxiv.org/html/2505.04094v1

### Blinks/Actions delivery vector

#### Malicious Solana Action endpoint delivering a drainer via a Blink
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **partial** → suggest: UNTRUSTED_ORIGIN_PLUS_PRIVILEGED_IX (shared): key on the instruction set, not the label; flag privileged instructions from unregistered Action URLs and feePayer/value-destination mismatch.
- **Mechanism:** An Action endpoint returns whatever serialized tx the attacker wants behind a friendly Blink label; the on-chain payload is decoupled from the UI caption. Spec assumes hostile endpoints.
- **On-chain signature:** Tx from an Actions endpoint (off-chain provenance) whose instructions don't match the Blink's stated intent; flag transfer/SetAuthority/Assign/AdvanceNonceAccount from an unregistered Action URL; feePayer is victim while value flows to an unrelated destination.
- **Real incidents:** Solana Foundation/Dialect Actions & Blinks launch with a trusted Actions Registry (mid-2024); CLINKSINK (Dec 2023–Jan 2024): airdrop-themed social signing lures, ~$900K+
- **Benchmark fixture:** Action-sourced tx labeled 'claim airdrop' containing SetAuthority to attacker; expect privileged-ix + origin flag.
- **Sources:** https://solana.com/developers/guides/advanced/actions, https://insights.blockbase.co/solana-actions-and-blinks-be-both-excited-and-cautious/, https://decrypt.co/236854/solana-foundation-launches-new-feature-social-media

### Custodial platform key compromise

#### Custodial trading-bot private-key leak (DEXX)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: BEHAVIORAL_SWEEP_HEURISTIC (shared) + cluster detection on shared consolidation wallets.
- **Mechanism:** DEXX centralized custody key leak let the attacker sign normal SOL/SPL transfers from thousands of users' accounts, sweeping balances. Valid owner-signed txns; failure is custodial key management.
- **On-chain signature:** Standard owner-signed SOL/SPL transfers fanning out from 8,600+ victim addresses into attacker consolidation wallets over a short window. Key on mass coordinated sweeps to shared collectors.
- **Real incidents:** DEXX hack 2024-11-16; SlowMist (2024-11-28) linked 8,612+ Solana addresses; ~$21M rising to ~$30M; 900+ users, one ~$1M
- **Benchmark fixture:** Valid owner-signed sweep into a known DEXX consolidation wallet; expect FLAGGED_ADDRESS + behavioral warning.
- **Sources:** https://cointelegraph.com/news/solana-dexx-hack-november-2024-suspicious-wallets, https://bravenewcoin.com/insights/dexx-hack-investigation-unveils-over-8600-solana-wallet-links-slowmist-report, https://cryptonews.com/exclusives/over-8600-solana-wallets-linked-to-dexx-hacker-slowmist/

### Delayed / pre-signed sweep drain

#### Durable-nonce pre-signed drain (advanceNonce delayed execution)
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: DURABLE_NONCE_PRESENT (shared) + DURABLE_NONCE_WITH_PRIVILEGED_IX: refuse advanceNonce paired with SetAuthority/Assign/UpgradeProgram/admin instructions in consumer flows.
- **Mechanism:** Durable nonce keeps a signed multi-transfer/authority-transfer tx valid indefinitely; attacker holds and submits later. Same primitive weaponized in the Drift hack.
- **On-chain signature:** First instruction System AdvanceNonceAccount referencing a Nonce account; combined with transfer/SetAuthority/closeAccount. The advanceNonce + SetAuthority/UpgradeProgram pairing has no legit workflow.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): 14 STMT txns used advanceNonce to delay execution; Drift Protocol (2026-04-01): durable-nonce pre-signed admin transfers, ~$285M, multisig bypass
- **Benchmark fixture:** Tx AdvanceNonceAccount + multi-transfer sweep; expect DURABLE_NONCE_PRESENT=high.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://www.coindesk.com/tech/2026/04/02/how-a-solana-feature-designed-for-convenience-let-an-attacker-drain-usd270-million-from-drift, https://solana.com/developers/guides/advanced/introduction-to-durable-nonces

### Delayed execution / fake simulation

#### Durable-nonce delayed-execution / fake-simulation drain
`high` · sim-detectable: **partial** · irreversible: **False** · coverage: **gap** → suggest: DURABLE_NONCE_PRESENT: flag any consumer-facing signing request whose first instruction is System AdvanceNonceAccount / recent_blockhash is a stored nonce; escalate when combined with transfer/SetAuthority/Assign.
- **Mechanism:** Tx built with a durable nonce (advanceNonceAccount first) so it never expires; wallet sims benign now, attacker submits later after state changed. Held tx often carries Approve/SetAuthority.
- **On-chain signature:** First instruction is System AdvanceNonceAccount; signed payload that does not expire and also contains token-mutating instructions.
- **Real incidents:** GoPlus (Aug 30 2024): Fake Simulation via durable nonce; Blowfish/Cointelegraph scam-as-a-service (2024): durable-nonce delayed submission
- **Benchmark fixture:** Tx with AdvanceNonceAccount at index 0 + Approve; expect DURABLE_NONCE_PRESENT=high.
- **Sources:** https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676, https://cointelegraph.com/news/scam-as-a-service-new-solana-drainers-identified

### Delayed signing abuse (durable nonce)

#### Durable-nonce delayed-execution / pre-signed admin transfer
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: DURABLE_NONCE_WITH_PRIVILEGED_IX (shared).
- **Mechanism:** Durable nonce keeps a signed tx valid indefinitely and unrevocable; attacker gets a benign-simulating pre-approval, executes later after state/governance changed. Drift: 2-of-5 admin transfer fired after a council migration.
- **On-chain signature:** First instruction System AdvanceNonceAccount (not a fresh blockhash) + high-privilege instructions (admin/authority transfer, upgrade-authority change, multisig approval).
- **Real incidents:** Drift durable-nonce drain ~$270M, executed 2026-04-01 (nonce accounts 2026-03-23/03-30; migration 2026-03-27; two txs four slots apart); Scam Sniffer/GoPlus durable-nonce signature-deception drainers (2024)
- **Benchmark fixture:** Tx AdvanceNonceAccount + admin/authority-transfer; expect DURABLE_NONCE_WITH_PRIVILEGED_IX=critical.
- **Sources:** https://www.coindesk.com/tech/2026/04/02/how-a-solana-feature-designed-for-convenience-let-an-attacker-drain-usd270-million-from-drift, https://solana.com/docs/core/transactions/durable-nonces, https://dev.to/ohmygod/anatomy-of-a-solana-wallet-drainer-owner-reassignment-durable-nonces-and-blinks-phishing-50a8

### Delayed-execution / pre-signed payload

#### Durable-nonce pre-signed 'time bomb'
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: DURABLE_NONCE_WITH_PRIVILEGED_IX (shared).
- **Mechanism:** Durable nonce keeps a phished/blind-signed tx valid indefinitely; held off-chain then submitted later. Drift: 2-of-5 council pre-signed; AdvanceNonceAccount -> proposalApprove -> vaultTransactionExecute(UpdateAdmin); setup >1 week.
- **On-chain signature:** First instruction System AdvanceNonceAccount referencing a nonce account; combined with a privileged/governance instruction (UpdateAdmin/SetAuthority/vaultTransactionExecute).
- **Real incidents:** Drift Protocol Apr 1 2026 ~$285.3M / ~$270M+: 2-of-5 council pre-signed; AdvanceNonceAccount -> proposalApprove -> vaultTransactionExecute(UpdateAdmin)
- **Benchmark fixture:** Tx AdvanceNonceAccount + vaultTransactionExecute(UpdateAdmin); expect DURABLE_NONCE_WITH_PRIVILEGED_IX=critical.
- **Sources:** https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation, https://www.coindesk.com/tech/2026/04/02/how-a-solana-feature-designed-for-convenience-let-an-attacker-drain-usd270-million-from-drift, https://www.chainalysis.com/blog/lessons-from-the-drift-hack/

### Delayed/replayed pre-signed wallet drain

#### Durable-nonce delayed-execution phishing drain (sign-now-drain-later)
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: DURABLE_NONCE_PRESENT (shared).
- **Mechanism:** Phishing dApp gets a durable-nonce signature; not broadcast at sign time so nothing appears to happen; submitted hours/days later. SolPhishHunter: 14 multi-transfer txns used advanceNonce.
- **On-chain signature:** AdvanceNonceAccount as instruction index 0 with a writable nonce account, in a tx that also contains value transfers/SetAuthority/Assign; recent_blockhash is a stored nonce not a live blockhash.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): 8,058 txns, 64 accounts, ~$1.1M, $136.49 avg; 14 used advanceNonce; GoPlus: durable-nonce sign-first/execute-later phishing
- **Benchmark fixture:** Phishing tx AdvanceNonceAccount + transfer; expect DURABLE_NONCE_PRESENT=high.
- **Sources:** https://arxiv.org/abs/2505.04094, https://arxiv.org/html/2505.04094v1, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676

### Delegate approval abuse

#### SPL Token Approve / ApproveChecked unlimited delegate
`high` · sim-detectable: **yes** · irreversible: **False** · coverage: **covered** (rule: `TOKEN_DELEGATE_APPROVE`)
- **Mechanism:** Victim signs Approve (4) / ApproveChecked (13) naming the attacker delegate with amount often u64::MAX; later the delegate Transfers/Burns up to delegated_amount with no further signature. Persists until Revoke.
- **On-chain signature:** Approve (4) or ApproveChecked (13) where delegate is not a known protocol PDA and amount is very large (especially u64::MAX); source ATA delegate/delegated_amount set post-tx.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): 8,058 instances, $1,099,815.98 total; STMT class $211,894.26; Scam Sniffer: 'Over $4 Million Stolen By Multiple Solana Wallet Drainers' (2024)
- **Benchmark fixture:** Tx with ApproveChecked delegate=attacker, amount=u64::MAX; expect TOKEN_DELEGATE_APPROVE=high (unlimited).
- **Sources:** https://arxiv.org/abs/2505.04094, https://solana.com/docs/tokens/basics/approve-delegate, https://drops.scamsniffer.io/over-4-million-stolen-by-multiple-solana-wallet-drainers/, https://academy.pandatool.org/en_US/solana/2315

#### Stale/unrevoked delegate approval drained months later
`high` · sim-detectable: **yes** · irreversible: **False** · coverage: **partial** → suggest: ACTIVE_DELEGATE_AUDIT: off-tx monitor enumerating all token accounts with a non-null delegate; flag unrecognized external delegates and key a drain tx on authority==stored delegate.
- **Mechanism:** SPL Approve has no expiry; a delegate granted today can Transfer/Burn weeks later. Only mitigation is owner Revoke.
- **On-chain signature:** Victim token accounts have non-null delegate with large delegated_amount set in a past block; later Transfer/Burn signed by that delegate (not owner). Enumerate token accounts with active external delegates.
- **Real incidents:** Scam Sniffer 'Over $4 Million' (2024): unrevoked approvals drained in later batches; SolPhishHunter (arXiv:2505.04094): STMT losses $211,894.26
- **Benchmark fixture:** Audit fixture: wallet with an ATA whose delegate is an unknown external pubkey; expect ACTIVE_DELEGATE_AUDIT warning.
- **Sources:** https://solana.com/docs/tokens/basics/revoke-delegate, https://help.phantom.com/hc/en-us/articles/19142125651731-Revoke-token-approvals, https://drops.scamsniffer.io/over-4-million-stolen-by-multiple-solana-wallet-drainers/

### Drainer kit / delivery

#### CLINKSINK / Chick / Rainbow drainer-as-a-service
`high` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `LARGE_SOL_OUTFLOW`)
- **Mechanism:** JS drainer kits phish a signature, then sweep SOL via SystemProgram.transfer and SPL via Token transfer to affiliate/operator wallets (80/20 split). Direct-transfer drain, not authority handover.
- **On-chain signature:** Signed tx with SystemProgram.transfer and/or SPL transfer to fresh collector wallets at connect time; no assign/SetAuthority. Distinguish from AAT: ownership unchanged.
- **Real incidents:** CLINKSINK (Mandiant/Google, Dec 2023–Jan 2024): >=35 affiliate IDs, 42 wallets, >=$900K, >$180K to operator B8Y1dERnVNoUUXeXA4NaCHiB9htcukMSkfHrFsTMHA7h; Chick/Rainbow variants; Rainbow + Node Drainer: 3,947 victims, >$4.17M as of Jan 2024
- **Benchmark fixture:** Tx sweeping near-full SOL + SPL to a fresh recipient; expect LARGE_SOL_OUTFLOW + LARGE_TOKEN_OUTFLOW.
- **Sources:** https://cloud.google.com/blog/topics/threat-intelligence/solana-cryptocurrency-stolen-clinksink-drainer-campaigns, https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing

### Drainer kit / scam-as-a-service

#### Solana drainer-as-a-service kits abusing durable nonces (Rainbow/Node/Aqua/Vanish)
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **partial** → suggest: UNTRUSTED_ORIGIN_PLUS_PRIVILEGED_IX: combine untrusted dApp/Blink origin with any of {advanceNonce, Assign, SetAuthority, multi-transfer, upgradeable-program} to raise composite risk.
- **Mechanism:** Commercial kits wrap durable-nonce delay, owner/authority reassignment, bit-flip, and multi-transfer into turnkey malicious dApps/Blinks; operators take a cut.
- **On-chain signature:** Tx from an unverified dApp/Blink requesting advanceNonce at index 0 and/or Assign/SetAuthority and/or multiple transfers to one attacker address and/or routing through a recently-deployed upgradeable program.
- **Real incidents:** Scam Sniffer: Rainbow + Node Drainer ~$4.17M / ~3,947 victims; Blowfish: Aqua + Vanish (Feb 9 2024); Solana phishing losses >$90M H1 2025 (industry reporting)
- **Benchmark fixture:** Tx from unverified Blink with advanceNonce + SetAuthority; expect composite UNKNOWN_PROGRAM + DURABLE_NONCE + SET_AUTHORITY.
- **Sources:** https://dune.com/scam-sniffer/solana-rainbow-drainer, https://crypto.news/blowfish-exposes-aqua-vanish-bit-flip-drainers-solana/, https://cointelegraph.com/news/scam-as-a-service-new-solana-drainers-identified

### Drainer on-chain mechanism

#### Single Transaction Multiple Transfers (STMT)
`high` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `FULL_TOKEN_ACCOUNT_DRAIN`)
- **Mechanism:** Packs many Transfer instructions (SOL + several SPL types) into one tx so one signature empties the wallet. Drain ix can hide behind a benign 'claim'/'connect' ix. Gck5...1VX4 ran 1,639 STMT txs.
- **On-chain signature:** One tx with COUNT(Transfer) > 2 driving 2+ token balances non-zero -> zero, all destinations the same unknown wallet, plus a near-full SOL System transfer.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): STMT peaked March 2024 (2,657 is total SolPhish, not STMT-only); Gck5...1VX4 1,639 STMT txs; Rainbow + Node Drainer: 3,947 victims / $4.17M+ (Jan 2024)
- **Benchmark fixture:** Tx with 3 SPL transfers to one recipient draining ATAs to zero + SOL transfer; expect FULL_TOKEN_ACCOUNT_DRAIN + MULTI_ASSET_SWEEP.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://cointelegraph.com/news/solana-wallet-drainers-target-users-amid-rise-in-sol-price

#### Account Authority Transfer (SetAuthority / Assign ownership hijack)
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `SET_AUTHORITY`)
- **Mechanism:** Changes ownership/authority so the drainer drains later out-of-band: SetAuthority(AccountOwner) on a token account, or System Assign on a wallet. Most damaging class: $812,219.75 (73.85%), avg $374; BNRT...5Rep 931 txs / $449,934.80.
- **On-chain signature:** SetAuthority (authority_type=account owner/close authority) on the user's token account, or System Assign changing a user account's owner to an unknown program; little/no immediate balance change.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): AAT $812,219.75 (73.85%); BNRT...5Rep 931 txs / $449,934.80
- **Benchmark fixture:** Tx SetAuthority(AccountOwner) to BNRT...5Rep with zero balance diff; expect SET_AUTHORITY=critical.
- **Sources:** https://arxiv.org/html/2505.04094v1

### Drainer-as-a-service ecosystem

#### Inferno / Angel / Pink drainer-as-a-service platforms
`critical` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `FULL_TOKEN_ACCOUNT_DRAIN`)
- **Mechanism:** Multi-chain DaaS platforms (incl. Solana) renting a hosted drainer + affiliate dashboard for a cut; affiliates spin up ~1,000 brand-impersonating phishing dApps; the platform auto-selects highest-value assets and routes a cut to operator wallets.
- **On-chain signature:** Drain tx from a phishing connect flow emptying SOL + top SPL/NFT to a fresh wallet, with a secondary split to a known operator/aggregator wallet; mass-cloned dApp domains + repeated drain-destination clusters; full-balance multi-asset sweeps fanning in from many victims.
- **Real incidents:** Inferno: $80M+ across ~1,000 phishing dApps (Feb-Nov 2023); ~$800k Christmas 2023; handed to Angel Oct 19 2024; Pink: ~$85M / 21,000+ victims, retired end May 2024; Scam Sniffer 2024: $494M / 332,000 wallets; Angel 42% / Pink 28% / Inferno 22%
- **Benchmark fixture:** Tx full-balance multi-asset sweep with operator split to a known drainer cluster; expect FLAGGED_ADDRESS + FULL_TOKEN_ACCOUNT_DRAIN.
- **Sources:** https://www.blockaid.io/blog/putting-inferno-drainer-group-out-of-business, https://drops.scamsniffer.io/scam-sniffer-2024-web3-phishing-attacks-wallet-drainers-drain-494-million/, https://www.bitget.com/news/detail/12560604287131, https://crypto.news/wallet-drainer-service-pink-drainer-to-wind-down-operations/

### Drainer-as-a-service kit

#### CLINKSINK drainer-as-a-service (Phantom/DappRadar/BONK lures)
`high` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `LARGE_SOL_OUTFLOW`)
- **Mechanism:** JS DaaS kit detects Phantom, POSTs the wallet to C2 (ontopothers[.]com) with a hardcoded AES key, gets a config (receiver, min_value, split), then builds a System.transfer + SPL transfer/createATA drain tx the victim signs. 5-25%/80% split. Operator B8Y1dERn... got 1,491+ SOL.
- **On-chain signature:** Single signed tx emptying SOL + SPL balances to one/two fresh unlabeled wallets, often split (affiliate + operator); destinations have no reputation.
- **Real incidents:** CLINKSINK since Dec 2023 ($900k+), Phantom/$PHNTM/DappRadar/BONK lures (Mandiant/Google); Mandiant X account compromise (Jan 3 2024) distributing CLINKSINK links; Chick -> Rainbow migration (Dec 23 2023)
- **Benchmark fixture:** Tx draining SOL+SPL split to two fresh wallets; expect LARGE_SOL_OUTFLOW + FULL_TOKEN_ACCOUNT_DRAIN.
- **Sources:** https://cloud.google.com/blog/topics/threat-intelligence/solana-cryptocurrency-stolen-clinksink-drainer-campaigns

### Drainer-as-a-service phishing kit

#### CLINKSINK drainer-as-a-service phishing campaigns
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `LARGE_SOL_OUTFLOW`)
- **Mechanism:** DaaS drainer via X/Discord airdrop lures impersonating Phantom/DappRadar/BONK; after connect the server (ontopothers[.]com) returns an AES-encrypted config and the JS drainer builds a transfer tx the victim signs; 80/20 split, 35+ affiliate IDs. Source leaked 2023-12-23.
- **On-chain signature:** Signed SOL/SPL transfers whose destination is the config receiver (operator B8Y1dERnVNoUUXeXA4NaCHiB9htcukMSkfHrFsTMHA7h); ordinary transfers to known collector/affiliate addresses.
- **Real incidents:** CLINKSINK (Mandiant/Google) Dec 2023-Jan 2024: $900K+ estimated, $180K+ (1,491+ SOL) to operator; 35+ affiliate IDs, 42 collectors
- **Benchmark fixture:** Tx transfer to operator B8Y1dERn...; expect FLAGGED_ADDRESS + LARGE_SOL_OUTFLOW.
- **Sources:** https://cloud.google.com/blog/topics/threat-intelligence/solana-cryptocurrency-stolen-clinksink-drainer-campaigns

### Drainer-as-a-service sweep

#### CLINKSINK / Chick / Rainbow drainer-as-a-service (SOL + token sweep)
`critical` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `FULL_TOKEN_ACCOUNT_DRAIN`)
- **Mechanism:** JS kit on airdrop pages builds one tx with SystemProgram.transfer + SPL transfers + JIT ATA creation; single signature sweeps SOL and SPL to operator/affiliate wallets (config from C2 ontopothers[.]com).
- **On-chain signature:** Single signed tx mixing System transfer + SPL transfer(s) + JIT ATA creation, destinations split between two attacker addresses. Known: B4y9s5E8rb79RH4BoQRTqQBPKxpEFxdkL1y3E5A9XYCK, B8Y1dERnVNoUUXeXA4NaCHiB9htcukMSkfHrFsTMHA7h.
- **Real incidents:** CLINKSINK (Mandiant/Google, Dec 2023+): 35+ affiliate IDs, 42 wallets, >=1,491 SOL (>$180k) to operator, ~$900k+; Rainbow + Node Drainer (Scam Sniffer): ~$4.17M / 3,947 victims; Rainbow $2.14M / 2,189
- **Benchmark fixture:** Tx sweeping SOL+SPL split to B4y9... and B8Y1...; expect FLAGGED_ADDRESS + FULL_TOKEN_ACCOUNT_DRAIN.
- **Sources:** https://cloud.google.com/blog/topics/threat-intelligence/solana-cryptocurrency-stolen-clinksink-drainer-campaigns, https://cryptonews.com/news/over-4-million-worth-of-assets-stolen-by-solanas-wallet-drainers-scam-sniffer/, https://drops.scamsniffer.io/scam-sniffer-2024-web3-phishing-attacks-wallet-drainers-drain-494-million/

### Fake airdrop / multi-asset drain

#### STMT airdrop/mint drainer (CLINKSINK-style)
`high` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `FULL_TOKEN_ACCOUNT_DRAIN`)
- **Mechanism:** One signed tx bundles multiple System.transfer + SPL transfers + createATA, draining several assets. CLINKSINK config from C2 ontopothers[.]com; operator 5-25% cut. SolPhishHunter STMT >2 transfers depleting 2+ token types; $211,894.26.
- **On-chain signature:** Multiple System Transfer + SPL Transfer in one tx moving balances out of signer-owned accounts to one/few attacker destinations, often preceded by createATA; known receivers B4y9s5E8rb79RH4BoQRTqQBPKxpEFxdkL1y3E5A9XYCK / B8Y1dERnVNoUUXeXA4NaCHiB9htcukMSkfHrFsTMHA7h.
- **Real incidents:** CLINKSINK (Mandiant/Google, Dec 2023-Jan 2024): ~$900K+, 1,491+ SOL, 35+ affiliate IDs, 42 wallets; Phantom/DappRadar/BONK lures; CLINKSINK -> Chick/Rainbow (Dec 23 2023); SolPhishHunter STMT tx f2MA...PaiC (5 transfers, 4 tokens + SOL)
- **Benchmark fixture:** Tx createATA + System transfer + 3 SPL transfers to known collector; expect FULL_TOKEN_ACCOUNT_DRAIN + FLAGGED_ADDRESS.
- **Sources:** https://cloud.google.com/blog/topics/threat-intelligence/solana-cryptocurrency-stolen-clinksink-drainer-campaigns, https://arxiv.org/html/2505.04094v1

### Front-end/library supply-chain compromise

#### @solana/web3.js npm supply-chain backdoor (addToQueue key exfil)
`high` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: BEHAVIORAL_SWEEP_HEURISTIC (shared) + FLAGGED_ADDRESS on known exfil wallets; primary defense is off-chain dependency audit (out of reviewer scope).
- **Mechanism:** Spear-phished @solana npm maintainer published trojanized web3.js v1.95.6/1.95.7 with an addToQueue function capturing private keys (disguised as CloudFlare headers) to sol-rpc[.]xyz; attacker then signs ordinary valid transfers.
- **On-chain signature:** Like Slope: normal owner-signed transfers to attacker collectors, not a special instruction. Detection is off-chain (lockfile/version audit); on-chain only sweep heuristics and the known exfil wallet.
- **Real incidents:** @solana/web3.js compromise: malicious versions ~3:20-8:25pm UTC 2024-12-02, disclosed 2024-12-03/04; clean v1.95.8; ~$190K+; CVE-2024-54134
- **Benchmark fixture:** Valid owner-signed sweep to the known web3.js exfil wallet; expect FLAGGED_ADDRESS + behavioral warning.
- **Sources:** https://www.helpnetsecurity.com/2024/12/04/solana-web3-js-supply-chain-compromise/, https://socket.dev/blog/supply-chain-attack-solana-web3-js-library, https://thehackernews.com/2024/12/researchers-uncover-backdoor-in-solanas.html, https://threats.wiz.io/all-incidents/solana-web3js-supply-chain-attack

### Multi-transfer sweep drain

#### STMT: Single Transaction with Multiple Transfers
`critical` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `FULL_TOKEN_ACCOUNT_DRAIN`)
- **Mechanism:** One tx bundles many transfer instructions moving several SPL types + SOL out at once. SolPhishHunter ref tx f2MA...PaiC had 5 transfers plundering 4 token types + SOL.
- **On-chain signature:** >2 transfer instructions in one tx where fee-payer/owner is source authority for all, 2+ distinct mints debited to near-zero, with one/few common attacker destinations.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): 2,438 STMT txns, $211,894.26, avg $86.91; top phisher Gck5...1VX4 1,639 txns; CLINKSINK (Mandiant/Google, Dec 2023+): single-signed SOL+token drains, ~$900k+, 35+ affiliate IDs
- **Benchmark fixture:** Tx with SystemProgram.transfer + 3 SPL transfers draining ATAs to zero to one recipient; expect FULL_TOKEN_ACCOUNT_DRAIN + MULTI_ASSET_SWEEP=critical.
- **Sources:** https://arxiv.org/abs/2505.04094, https://arxiv.org/html/2505.04094v1, https://cloud.google.com/blog/topics/threat-intelligence/solana-cryptocurrency-stolen-clinksink-drainer-campaigns

### Owner reassignment (simulates as no-op)

#### Hidden wallet-account owner reassignment via SystemProgram::assign
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `ACCOUNT_REASSIGN`)
- **Mechanism:** System assign (index 1) rewrites the Owner of the victim's system account; no lamport/token delta so balance-diff sim shows nothing. Attacker's program then drains in a later tx. Coinspect PoC reproduces it in two stages.
- **On-chain signature:** System assign (index 1) whose target is the signer's own wallet and whose new owner is not the System Program, especially co-bundled with a benign transfer.
- **Real incidents:** Coinspect 'Transaction Simulation Challenges': Phantom+Blowfish missed assign; reported Apr 5, fixed Apr 7 2023; SlowMist (Dec 4 2025): victim signed assign, lost transfer/revoke/DeFi ability; SolPhishHunter AAT: 2,171 txs, $812,219.75
- **Benchmark fixture:** Tx with System assign (index 1) re-owning the signer + decoy transfer; expect ACCOUNT_REASSIGN=critical.
- **Sources:** https://www.coinspect.com/blog/transaction-simulation-challenges/, https://github.com/coinspect/solana-assign-test, https://slowmist.medium.com/beware-of-solana-phishing-attacks-wallet-owner-permissions-may-be-altered-708bbb30518e, https://arxiv.org/html/2505.04094v1

#### SPL token-account authority transfer via SetAuthority
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `SET_AUTHORITY`)
- **Mechanism:** SetAuthority authorityType AccountOwner/CloseAuthority on the victim's ATA; moves no balance at sign time so balance-diff sim is zero. Solana-native equivalent of an unlimited approval but full ownership.
- **On-chain signature:** SPL Token (Tokenkeg...) or Token-2022 SetAuthority with authority_type=AccountOwner or CloseAuthority and new authority != signer.
- **Real incidents:** SolPhishHunter AAT: 2,171 txs, $812,219.75; peak Jan-Jun 2024 (83.62%); SolPhishHunter overall: 8,058 txs, ~$1.1M, 64 accounts (arXiv:2505.04094)
- **Benchmark fixture:** Tx SetAuthority(AccountOwner) on a user ATA, zero balance diff; expect SET_AUTHORITY=critical.
- **Sources:** https://arxiv.org/abs/2505.04094, https://arxiv.org/html/2505.04094v1

### Ownership / authority hijack

#### AAT — wallet/token-account ownership seizure via Assign + SetAuthority
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `ACCOUNT_REASSIGN`)
- **Mechanism:** System Assign sets the owner of the victim's account to a phishing program; the tx then calls SetAuthority(AccountOwner) on the token account. Tokens remain visible but unspendable. SolPhishHunter tx 4GVr...tYAn; AAT $812,219.75 (73.85%).
- **On-chain signature:** System Assign changing a signer-owned account's owner away from System, and/or SetAuthority authorityType=AccountOwner/CloseAccount with new authority != signer. No transfer/approve needs to appear.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): tx 4GVr...tYAn Assign+SetAuthority; AAT $812,219.75 (73.85%); largest single ~$751,888; GoPlus 'Authority Transfers' createSetAuthorityInstruction seizure
- **Benchmark fixture:** Tx with Assign + SetAuthority(AccountOwner) to a phishing program; expect ACCOUNT_REASSIGN + SET_AUTHORITY=critical.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676

### Phishing / social-engineering on-chain mechanism

#### Impersonation of System Accounts + address poisoning (ISA)
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: LOOKALIKE_RECIPIENT + SYSTEM_ACCOUNT_IMPERSONATION + DUST_SEED_HISTORY (shared).
- **Mechanism:** Grind vanity addresses ('Compu' prefix / '1111' suffix) or first/last-4-char counterparty matches; seed history with dust; victim sends real funds to the lookalike. ISA gang Qcsb...1111/np84...11111: 2,071 txs / $466,279.20.
- **On-chain signature:** Transfer whose destination matches a trusted address by prefix/suffix or shares only first-4/last-4 chars with the intended recipient; preceded by 0/dust inbound from such lookalikes.
- **Real incidents:** $2.91M PYTH (Nov 2024) 4yfuQC...izcY vs 4yfu48...gnhY; Two victims lost 272 SOL; same actor $3.1M+ in a month; Fake System Program poisoning (Scam Sniffer, Feb 3 2024); SolPhishHunter ISA gang 2,071 txs / $466,279.20
- **Benchmark fixture:** Transfer to a first4/last4-matching lookalike of a recent recipient; expect LOOKALIKE_RECIPIENT=high.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://www.the-blockchain.com/2024/11/25/solana-user-losses-2-91million-in-an-address-poisoning-scam-are-these-scams-becoming-a-nightmare-for-crypto-users/, https://www.panewslab.com/en/sqarticledetails/4o356blv.html

### Pre-signed durable-nonce governance/admin takeover

#### Drift Protocol governance takeover via pre-signed durable-nonce multisig txns
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: DURABLE_NONCE_WITH_PRIVILEGED_IX (shared): flag AdvanceNonceAccount-at-index-0 + multisig vault-execute + admin/owner/authority-transfer instruction; surface nonce accounts tied to admin/multisig keys.
- **Mechanism:** Social-engineered 2-of-5 Squads council into blind-signing durable-nonce txns; on Apr 1 2026 two pre-signed txns 4 slots apart executed AdvanceNonceAccount -> proposalApprove -> vaultTransactionExecute -> UpdateAdmin, handing admin to HkGz4K...pZES; zero timelock.
- **On-chain signature:** First instruction System AdvanceNonceAccount (NONCED_TX_MARKER_IX_INDEX=0) with a writable nonce account at index 0; paired with Squads vaultTransactionExecute + a privileged admin instruction (Drift UpdateAdmin). Nonce account created outside normal governance cadence.
- **Real incidents:** Drift Protocol Apr 1 2026 — ~$285.3M ($285,279,417.69) drained; 2-of-5 Squads zero timelock; laundered via NEAR/Backpack/Wormhole/CCTP (~$230M) and Tornado Cash
- **Benchmark fixture:** Tx AdvanceNonceAccount + vaultTransactionExecute(UpdateAdmin); expect DURABLE_NONCE_WITH_PRIVILEGED_IX=critical.
- **Sources:** https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation, https://www.coindesk.com/tech/2026/04/02/how-a-solana-feature-designed-for-convenience-let-an-attacker-drain-usd270-million-from-drift, https://www.chainalysis.com/blog/lessons-from-the-drift-hack/

### Recent-blockhash / replay-state trick

#### Durable-nonce delayed execution (sign now, swap code, execute later)
`high` · sim-detectable: **no** · irreversible: **True** · coverage: **gap** → suggest: DURABLE_NONCE_PRESENT (shared) + UPGRADEABLE_PROGRAM_MUTABLE_AUTHORITY (shared): the pairing is the keyable anomaly.
- **Mechanism:** Durable-nonce tx never expires; wallet sims benign mint_nft() against current bytecode; attacker upgrades/replaces program code after sign, before submit, so execution runs the malicious version.
- **On-chain signature:** AdvanceNonceAccount as first instruction in lieu of a recent blockhash; tx invokes an upgradeable (BPFLoaderUpgradeable-owned) program whose authority is not the user.
- **Real incidents:** Two-phase durable-nonce drainer documented (dev.to ohmygod); Helius durable-nonce primer; Blockaid TOCTOU: Lighthouse does not cover the majority of drains
- **Benchmark fixture:** Tx AdvanceNonceAccount + upgradeable-program call (third-party authority); expect DURABLE_NONCE + UPGRADEABLE_PROGRAM flags.
- **Sources:** https://www.helius.dev/blog/solana-transactions, https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing, https://solana.com/docs/core/transactions/durable-nonces

### Simulation bypass

#### TOCTOU / bitflip drainers (state changed between sign and execute)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: SIM_INFLOW_BUT_WRITABLE_TO_FOREIGN: flag when sim shows inflow to the signer yet the signer's accounts/authorities are writable to an unverified foreign program.
- **Mechanism:** Dormant branch gated on on-chain state (existence of a token account for a specific mint). Sim shows funds flowing TO the user; after sign attacker flips state then submits; drain runs. ~$3,000, 7 blocks.
- **On-chain signature:** Non-allowlisted/recently-deployed program; upgradeable (mutable upgrade authority); simulated inflow to signer yet signer accounts writable to a foreign program. State-gating mint example CPMbUt3...xatt.
- **Real incidents:** Blowfish Aqua/Vanish (2024-02-09); Blockaid: Vanish ~$3,000 7 blocks after state-set
- **Benchmark fixture:** Tx simulating an inflow to signer while granting writable access to an unknown program; expect UNKNOWN_PROGRAM + inflow-mismatch flag.
- **Sources:** https://crypto.news/blowfish-exposes-aqua-vanish-bit-flip-drainers-solana/, https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing

#### Upgradeable-program swap after benign simulation
`high` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: UPGRADEABLE_PROGRAM_MUTABLE_AUTHORITY (shared): warn that bytecode at sign time is not guaranteed at execution; treat mutable-upgrade-authority + durable-nonce as high.
- **Mechanism:** Route through a benign upgradeable program so sim is clean and the user signs; attacker then upgrades the program (Upgrade) to malicious code and broadcasts the held (often durable-nonce) tx. Solana instruction is 'Upgrade' (not 'SetCode').
- **On-chain signature:** Call into a BPFLoaderUpgradeable program (owner=BPFLoaderUpgradeab1e11111111111111111111111) whose ProgramData has a still-present (mutable) upgrade authority; high-risk with 'recently upgraded' + durable nonce.
- **Real incidents:** GoPlus: legitimate-then-upgraded contract + durable nonce anti-simulation (2024); Drainer advertised to bypass all simulations, reported 2024-02-20 (Mikko Ohtamaa)
- **Benchmark fixture:** Tx invoking an upgradeable program with mutable authority via a durable nonce; expect UPGRADEABLE_PROGRAM_MUTABLE_AUTHORITY=high.
- **Sources:** https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676, https://coinpaper.com/3392/wallet-drainer-promises-to-bypass-any-transaction-simulation-now-available-for-sale

#### Fake-simulation switch (fabricated/merged simulation results)
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: TRUSTED_RESIMULATION: never trust a dApp-provided simulation; always re-simulate against a trusted node and flag divergence; flag merged/oversized instruction sets and non-default RPC.
- **Mechanism:** Malicious dApp fabricates the simulation the wallet shows via a server-side switch; after signing, disables the switch and submits the real malicious tx. Also merges txns / uses malicious plugins.
- **On-chain signature:** Not in signed bytes — deception is in the RPC/preview layer. Defensive: re-simulate against a trusted/forked RPC; flag when executed net effect diverges from the dApp-supplied preview.
- **Real incidents:** Scam Sniffer 'Over $4 Million' (2024): simulation-fabrication switch; GoPlus (2024): merged-transaction and fake-simulation methods
- **Benchmark fixture:** Tx whose dApp-provided preview shows a gain but trusted re-sim shows an outflow; expect TRUSTED_RESIMULATION=high.
- **Sources:** https://drops.scamsniffer.io/over-4-million-stolen-by-multiple-solana-wallet-drainers/, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676

### Simulation evasion

#### Simulation-spoofing owner/authority handover (Bull Checker)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **gap** → suggest: SIMULATION_STATE_DEPENDENT_BRANCH: flag txns invoking an unknown/unverified program that reads a writable account's lamport balance as a gating condition, and/or txns submitted inside a Jito bundle bracketed by attacker deposit/withdraw; require post-state guard assertions.
- **Mechanism:** Malicious program gates the drain on a 'switch' account balance: benign when non-zero (sim state), drains when momentarily zero via a Jito sandwich at execution. Bull Checker extension injected instructions into unsigned swaps before Phantom's preview.
- **On-chain signature:** Program reads a switch-account balance and branches; dangerous branch unreachable under simulated state. Tell: tx is part of a Jito bundle with attacker deposit/withdraw bracketing; an unexpected program gating on a balance condition; absence of Lighthouse/SafeGuard post-state assertions.
- **Real incidents:** Bull Checker simulation-spoofing (2024-2025): Phantom/Blowfish/Jupiter/Raydium affected; root cause traced by Offside Labs, Blowfish, Jupiter, Raydium, Phantom; Fix: Blowfish SafeGuard; Phantom + Lighthouse Guard instructions (audited by OtterSec)
- **Benchmark fixture:** Tx invoking an unknown program that branches on a third input account's balance, wrapped in a Jito bundle; expect SIMULATION_STATE_DEPENDENT_BRANCH=critical.
- **Sources:** https://blog.offside.io/p/stop-spoofing-my-wallet, https://phantom.com/learn/blog/anti-spoofing-security, https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing

#### TOCTOU drainer: post-signature state mutation (Vanish)
`high` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: TOCTOU_STATE_GATED_UNKNOWN_PROGRAM: when an unverified program reads an account whose state an attacker can mutate (and a benign sim result is small/neutral), warn that simulation cannot be trusted; recommend Lighthouse post-state assertions.
- **Mechanism:** Sim does not account for state changes between sign and execute. Attacker controls dApp+program; program inert at sim time, drains after a post-sign state mutation. Triggered on existence of a token account for mint CPMbUt3SSoeoCJGCzhqmy7ZoaHWqd8AQPTvYiNeSxatt; ~$3,000 in a 7-block window.
- **On-chain signature:** Unverified/closed-source program gated on external mutable state (token-account existence, mint, balance) differing between sim and execution; executed inside tight block windows/bundles.
- **Real incidents:** Blockaid Vanish: program HkRdHHqMWrgDa1rj99TArnvxBskXPLt9LWmkPLqfoynz, mint CPMbUt3SSoeoCJGCzhqmy7ZoaHWqd8AQPTvYiNeSxatt, ~$3,000 in 7 blocks
- **Benchmark fixture:** Tx invoking an unknown program reading a mint-conditioned account; sim shows ~no change; expect UNKNOWN_PROGRAM + TOCTOU warning.
- **Sources:** https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing

#### Bit-flip simulation evasion (Aqua / Vanish kits)
`high` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: POST_SIGN_STATE_MUTATION_RISK: flag known drainer-kit program IDs and unverified programs whose effect depends on mutable decoded data; recommend Lighthouse assertions and refusing to sign conditional-effect txns.
- **Mechanism:** Drainer flips bits in on-chain data after the user signs, altering a decoded condition so the program flips from facilitator to drainer at submit time.
- **On-chain signature:** Closed-source program whose execution path depends on a data field mutated between sign and submit; known kit program IDs (Aqua/Vanish). Detected only by post-state guard assertions.
- **Real incidents:** Blowfish (Feb 9 2024): Aqua and Vanish bit-flip drainers; 6,000+ member Solana drainer community (Chainalysis Jan 2024), suspected Russian devs
- **Benchmark fixture:** Tx invoking a flagged Aqua/Vanish-family program; expect FLAGGED_ADDRESS or UNKNOWN_PROGRAM + post-sign-mutation warning.
- **Sources:** https://crypto.news/blowfish-exposes-aqua-vanish-bit-flip-drainers-solana/, https://www.blockaid.io/blog/bypasses-how-attackers-evade-transaction-simulation

#### TOCTOU state-manipulation drainer bypassing pre-sign simulation
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: WRITABLE_SCOPE_VS_SIM_EFFECT_MISMATCH: flag when an unverified program holds broad writable scope over signer accounts but the simulated effect is near-zero; cross-check submitter != signer.
- **Mechanism:** Signing grants involved programs write access to writable accounts; drain logic gated on state OFF during sim. After sign attacker flips state ON then submits. Vanish: token account for mint CPMbUt3...xatt; 7-block gap; ~$3,000.
- **On-chain signature:** Unfamiliar/recently-deployed program with broad writable access to the signer's accounts but near-zero simulated effect; a closely-preceding attacker tx mutating a state/flag account; signed tx submitted by a third party.
- **Real incidents:** Blockaid Vanish: state-set 247363970, drain 247363977, ~$3,000, mint CPMbUt3...xatt
- **Benchmark fixture:** Tx granting an unknown program writable access to all signer accounts with near-zero sim effect; expect MANY_WRITABLE_ACCOUNTS + scope-mismatch flag.
- **Sources:** https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing

### Simulation evasion (TOCTOU)

#### TOCTOU / bit-flip simulation-bypass drainers (Aqua, Vanish)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: TOCTOU_STATE_GATED_UNKNOWN_PROGRAM (shared).
- **Mechanism:** Victim signs a benign-simulating tx; attacker (controlling dApp/backend) submits a separate tx mutating state (Vanish: marker token account for mint CPMbUt3...xatt) that flips the program's hidden branch, then broadcasts the signed tx to drain.
- **On-chain signature:** Signed message invokes an attacker-deployed program with conditional logic keyed on existence/state of an external account or PDA; near-simultaneous attacker tx (7 slots before, 247363970 vs 247363977) initializing the trigger.
- **Real incidents:** Aqua & Vanish (Blowfish, 2024-02-09); Blockaid Vanish TOCTOU: token-account state trigger, ~$3K
- **Benchmark fixture:** Tx invoking an unknown program gated on a PDA the attacker pre-initializes; expect UNKNOWN_PROGRAM + TOCTOU.
- **Sources:** https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing, https://crypto.news/blowfish-exposes-aqua-vanish-bit-flip-drainers-solana/, https://coinpaper.com/3392/wallet-drainer-promises-to-bypass-any-transaction-simulation-now-available-for-sale

### Simulation-bypass (TOCTOU) drain

#### TOCTOU / bit-flip drain via mutable program state (Aqua & Vanish)
`high` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: UPGRADEABLE_PROGRAM_MUTABLE_AUTHORITY: flag writable accounts handed to an upgradeable program with a still-present (mutable) upgrade authority; warn sign-time bytecode != execution bytecode; recommend Lighthouse assertions.
- **Mechanism:** Benign sim; conditional gated on mutable state; after sign attacker flips the bit / upgrades the program so the writable-account authorization drains. Durable nonces widen the gap. Vanish gated on mint CPMbUt3...xatt.
- **On-chain signature:** Sign request routing through a recently-deployed or BPFLoaderUpgradeable-upgradeable program with writable accounts whose state/mint condition isn't pinned; no Lighthouse-style assertion.
- **Real incidents:** Blowfish Aqua/Vanish (Feb 9 2024) scam-as-a-service; Blockaid Vanish: ~$3,000 across ~7 blocks, mint CPMbUt3...xatt
- **Benchmark fixture:** Tx granting writable accounts to a mutable-upgrade-authority program with near-zero sim effect; expect UPGRADEABLE_PROGRAM_MUTABLE_AUTHORITY=high.
- **Sources:** https://crypto.news/blowfish-exposes-aqua-vanish-bit-flip-drainers-solana/, https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing, https://cointelegraph.com/news/scam-as-a-service-new-solana-drainers-identified

### Simulation-bypass drainer technique

#### TOCTOU / bit-flip simulation bypass (Vanish & Aqua)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: WRITABLE_SCOPE_VS_SIM_EFFECT_MISMATCH (shared) + SUBMITTER_NOT_SIGNER: compare simulated vs live state of writable accounts and flag third-party submission.
- **Mechanism:** Drain path gated on hidden on-chain state OFF at sim; dApp holds the signature, lands a state-setting tx flipping the gate, then submits within a few blocks. Vanish keyed on a token account for mint CPMbUt3...xatt; 7-block gap; ~$3,000. (Note: a program can only mutate accounts it owns/is authorized for.)
- **On-chain signature:** Tx passes writable accounts (program-state PDAs, token accounts) it doesn't appear to need; a same-window setup tx from the dApp/relayer mutates one of them; signed tx submitted by a third party (durable nonce/relayer).
- **Real incidents:** Blowfish Aqua/Vanish (Feb 2024) scam-as-a-service; Blockaid Vanish: block 247363977 (~$3,000), mint CPMbUt3...xatt
- **Benchmark fixture:** Tx passing unneeded writable PDAs with near-zero sim effect, submitted by a relayer; expect MANY_WRITABLE_ACCOUNTS + scope-mismatch.
- **Sources:** https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing, https://crypto.news/blowfish-exposes-aqua-vanish-bit-flip-drainers-solana/, https://bitcoinworld.co.in/blowfish-detected-new-aqua-vanish-transaction-drainers-on-solana-sol/

### Simulation-bypass primitive

#### Durable-nonce marker abuse to defeat pre-sign simulation
`medium` · sim-detectable: **no** · irreversible: **True** · coverage: **gap** → suggest: DURABLE_NONCE_PRESENT (shared): detect the index-0 AdvanceNonceAccount marker + nonce-as-blockhash; warn simulation reflects 'now,' not execution time.
- **Mechanism:** The structural rule that AdvanceNonceAccount must be index 0 and the nonce substitutes for recent_blockhash is weaponized: sim reflects current state, but the tx executes later when state has changed.
- **On-chain signature:** recent_blockhash equals a stored durable nonce AND instruction 0 is System AdvanceNonceAccount with a writable nonce account first; for consumer flows this marker is the keyable anomaly.
- **Real incidents:** GoPlus: durable-nonce + upgradeable-contract simulation mismatch; Blockaid TOCTOU: sims don't account for state changes between sign and execute; Drift Apr 1 2026: pre-signed durable-nonce txns executed days later
- **Benchmark fixture:** Tx whose recent_blockhash is a nonce value with AdvanceNonceAccount at index 0; expect DURABLE_NONCE_PRESENT flag.
- **Sources:** https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676, https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing, https://solana.com/docs/core/transactions/durable-nonces

### Simulation-evading sweep drain

#### TOCTOU / bit-flip drainer (Aqua & Vanish) - simulation evasion
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: TOCTOU_STATE_GATED_UNKNOWN_PROGRAM (shared).
- **Mechanism:** Benign sim result; after sign attacker flips an on-chain conditional so the program TAKES instead of SENDS. Vanish keyed on existence of a token account with mint CPMbUt3SSoeoCJGCzhqmy7ZoaHWqd8AQPTvYiNeSxatt.
- **On-chain signature:** Closed-source/no-IDL program with writable victim accounts; benign/neutral sim movement; a conditional state account writable by the attacker.
- **Real incidents:** Aqua & Vanish (Blowfish, Feb 2024) scam-as-a-service; Blockaid Vanish TOCTOU: ~$3,000 block 247363977, state-set 247363970
- **Benchmark fixture:** Tx invoking an unverified program with broad writable scope and near-zero sim effect; expect UNKNOWN_PROGRAM + TOCTOU.
- **Sources:** https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing, https://bitcoinworld.co.in/blowfish-detected-new-aqua-vanish-transaction-drainers-on-solana-sol/, https://cointelegraph.com/news/scam-as-a-service-new-solana-drainers-identified

### Social-feed phishing (Blinks/Actions)

#### Solana Actions/Blinks malicious transaction payload
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **partial** → suggest: HIDDEN_AUTHORITY_CHANGE_IN_BUNDLE: surface every Assign/SetAuthority even when bundled with benign ATA-create/small transfers; flag any ownership change of a signer-owned account.
- **Mechanism:** A malicious Action endpoint returns a payload mixing innocuous instructions (create ATA, small 'gas' transfer) with a damaging Assign(victim_account, attacker_program) or SetAuthority; users skim and approve. Dialect registry only gates which Blinks unfurl, not endpoint payloads.
- **On-chain signature:** Bundled message where one instruction is a high-impact authority/ownership change (System Assign to an attacker program, or SetAuthority) hidden among benign ATA-create and small-transfer instructions. Surface every Assign/SetAuthority.
- **Real incidents:** Solana Blinks phishing (fake airdrop/free-mint Blinks on X) 2024-Q1 2026; broader Solana phishing $90M+ H1 2025
- **Benchmark fixture:** Action payload with createATA + small transfer + Assign(victim, attacker program); expect ACCOUNT_REASSIGN=high despite benign siblings.
- **Sources:** https://dev.to/ohmygod/anatomy-of-a-solana-wallet-drainer-owner-reassignment-durable-nonces-and-blinks-phishing-50a8, https://solana.com/developers/guides/advanced/actions

### System/program/address impersonation

#### Impersonation of System Account (ISA) via vanity pubkey (Compu*, *1111)
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: SYSTEM_ACCOUNT_IMPERSONATION: regex-match recipient against /Compu.*/ or /.*1111/ patterns and full-string compare against canonical program IDs; flag near-match-not-equal.
- **Mechanism:** solana-keygen grind/SlerfTools brute-force vanity keypairs resembling native accounts ('1111' suffix, 'Compu' prefix); victim signs a Transfer to the lookalike.
- **On-chain signature:** Recipient matches 'Compu.*' OR '.*1111' (or mimics a system account) yet is an EOA, not the real program id; compare against canonical hardcoded program ids.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): ISA 3,449 txs, ~$75,701.98, avg $21.95, peaked Jan-Jun 2024; Phisher 'CaNC...1111': 1,692 ISA attempts, ~$43,547
- **Benchmark fixture:** Transfer to a '....1111' vanity EOA mimicking System Program; expect SYSTEM_ACCOUNT_IMPERSONATION=high.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://arxiv.org/abs/2505.04094, https://ieeexplore.ieee.org/document/11320875/

#### Address poisoning via prefix/suffix-matched vanity recipient ($2.91M PYTH)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **gap** → suggest: LOOKALIKE_RECIPIENT + DUST_SEED_HISTORY: at sign time compare recipient head/tail vs the user's historical recipients (flag near-match-not-equal); flag a recipient whose only history is a single dust inbound.
- **Mechanism:** Vanity address matching first/last chars of a victim's frequent address; dust transfer seeds history; victim copies the lookalike. Nov 2024 $2.91M PYTH to 4yfuQCL4...izcY vs 4yfu48qw...gnhY.
- **On-chain signature:** Inbound dust (<0.5 SOL) from a fresh account whose head/tail base58 match a known counterparty, arriving near a large legit transfer; at sign time an outbound transfer whose truncated display collides with a prior counterparty but full base58 differs in the middle.
- **Real incidents:** Nov 2024: $2.91M PYTH to 4yfuQCL4fnNfSbBgqFcPTFn5GGZABDaEFQLhGpwjizcY (legit 4yfu48qwim7hGzD3Nphzd2A6ThydzysfKi4wBPFSgnhY); Scam Sniffer; Scam Sniffer: two victims lost 272 SOL; May 2025: trader lost $2.6M USDT to address poisoning twice in 3 hours
- **Benchmark fixture:** Outbound transfer to an address sharing head+tail with a prior CEX deposit but differing in the middle; expect LOOKALIKE_RECIPIENT=critical.
- **Sources:** https://www.the-blockchain.com/2024/11/25/solana-user-losses-2-91million-in-an-address-poisoning-scam-are-these-scams-becoming-a-nightmare-for-crypto-users/, https://pineanalytics.substack.com/p/solana-account-dusting-and-address, https://www.chaincatcher.com/en/article/2157079, https://www.blockaid.io/blog/address-poisoning-the-growing-threat-draining-millions-from-crypto-users

#### AAT: SetAuthority / Assign handing over account ownership
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **covered** (rule: `SET_AUTHORITY`)
- **Mechanism:** Victim signs SetAuthority(AccountOwner) or System Assign reassigning ownership of their wallet/token account to the attacker; control then used to sweep. Tokens still appear in wallet.
- **On-chain signature:** SetAuthority (Tokenkeg.../Token-2022) authorityType=AccountOwner/CloseAccount/FreezeAccount with new authority unfamiliar; OR System Assign reassigning the signer's account to a non-system program. No value moves in this tx.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): AAT Assign+SetAuthority chain, sweep to multiple accounts; GoPlus: createSetAuthorityInstruction owner change so victim cannot move tokens
- **Benchmark fixture:** Tx with SetAuthority(AccountOwner) + zero balance change; expect SET_AUTHORITY=critical (no-value-move handover).
- **Sources:** https://arxiv.org/html/2505.04094v1, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676

#### Counterfeit SPL token impersonating known asset (USDC/USDT/JUP lookalike mint)
`high` · sim-detectable: **yes** · irreversible: **False** · coverage: **gap** → suggest: COUNTERFEIT_TOKEN_MINT: resolve each token's mint and compare symbol/name against a canonical-mint allowlist; flag symbol/name match with mint mismatch and mutable (un-revoked) metadata authority.
- **Mechanism:** New mint with the symbol/name of a mainstream asset via metadata but a different mint pubkey; airdropped or used as fake collateral; UIs showing symbol/name mislead users.
- **On-chain signature:** Token whose displayed symbol/name matches a major asset but mint pubkey is not canonical (not EPjFWdd5...USDC, Es9vMFrz...USDT, JUPyiwrY...JUP). Resolve every token to its mint and compare to a canonical allowlist; flag mutable metadata.
- **Real incidents:** Fake $CJUP airdrop (2025-2026) impersonating Jupiter Jupuary; Drift Protocol Apr 1 2026: fake CVT collateral against disabled withdrawal limits (mischaracterized as pure symbol-impersonation); GoPlus: counterfeit tokens reusing symbols of USDT/SOLANA
- **Benchmark fixture:** Tx involving a token labeled USDC whose mint != EPjFWdd5...; expect COUNTERFEIT_TOKEN_MINT=high.
- **Sources:** https://www.cryptopolitan.com/fake-jupiter-aidrop-jupuary-wallet-drainer/, https://www.mexc.com/news/1108045, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676, https://www.cryptotimes.io/2026/04/03/285m-gone-in-12-minutes-how-a-fake-token-and-stolen-keys-gutted-drift-protocol/

#### Token-2022 metadata-extension name/symbol spoof via un-revoked update authority
`medium` · sim-detectable: **yes** · irreversible: **False** · coverage: **gap** → suggest: TOKEN2022_MUTABLE_METADATA: read the mint metadata extension update-authority state; flag mutable mints whose name/symbol impersonates a known token and any UpdateField/metadata update.
- **Mechanism:** Token-2022 metadata extension stores name/symbol/logo on the mint; if update authority isn't revoked, the holder can later change them to impersonate USDC or embed phishing links.
- **On-chain signature:** Token-2022 mint with metadata extension where Mutable=true / update authority present, especially when name/symbol matches a known asset; flag any post-mint UpdateField changing name/symbol/uri.
- **Real incidents:** Token-2022 metadata-mutability phishing vector documented (RareSkills, Ledger, Helius authority guidance)
- **Benchmark fixture:** Token-2022 mint with mutable metadata named 'USDC'; expect TOKEN2022_MUTABLE_METADATA=medium.
- **Sources:** https://rareskills.io/post/token-2022, https://support.ledger.com/article/Solana-Token-Extensions, https://www.helius.dev/docs/orb/explore-authorities

#### Domain-named account dusting (SNS/AllDomains vanity wallets)
`low` · sim-detectable: **yes** · irreversible: **False** · coverage: **gap** → suggest: DUST_INBOUND_NAMED_SENDER: flag inbound sub-fee-floor transfers from named/domain senders; never auto-interact; note names are not a vouch.
- **Mechanism:** Branded SNS/AllDomains names resolve to attacker wallets and render in history; spam micro-transfers below the fee floor drive victims to off-chain gambling/phishing sites. Pine Analytics: 40 wallets, ~6.2M targets, 5.2M txs, ~26.1 SOL.
- **On-chain signature:** Inbound dust (<~0.000005 SOL) from a sender resolving to a human-readable SNS/AllDomains name; gas > transferred value. Warn that a name shown in history is attacker-chosen.
- **Real incidents:** Pine Analytics (Apr 2025): 40 wallets, ~6.2M targets, 5.2M txs, 84M transfers; flip.gg ~18 SOL, OdinBot.io ~3 SOL, Crashout.fun ~4 SOL, WalletX.gg ~0.25 SOL; Solflare dusting/poisoning warnings (2025)
- **Benchmark fixture:** Inbound 0.000001 SOL from flip.gg-resolving wallet; expect DUST_INBOUND_NAMED_SENDER=low.
- **Sources:** https://pineanalytics.substack.com/p/solana-account-dusting-and-address, https://x.com/PineAnalytics/status/1915541130210664859

#### Unsolicited fake-airdrop token/NFT routing to a drainer
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **partial** → suggest: UNSOLICITED_AIRDROP_THEN_AUTHORITY_CHANGE: correlate an unknown-mint airdrop bearing a project name with a follow-on tx granting delegate/owner authority or multi-asset sweep to one recipient.
- **Mechanism:** Airdrop an unsolicited token/NFT impersonating a real project's airdrop with phishing-link metadata; the 'claim' flow leads to a drainer tx (delegate/approve, SetAuthority, or sweep).
- **On-chain signature:** Unsolicited token/NFT with project-impersonating name + non-canonical mint + phishing-link metadata; the dangerous signature is the follow-on drainer tx granting delegate/owner authority or sweeping multiple high-value tokens to one fresh recipient.
- **Real incidents:** Fake $CJUP Jupiter/Jupuary airdrop (2025-2026); GoPlus: NFT 'redeem 1,000 ZERO' phishing drained BONK/ZERO/USDC; Rainbow + Node Drainer: ~$4.17M / 3,967 wallets since late Nov 2023 (entry mis-dated 2024)
- **Benchmark fixture:** Claim tx (after fake airdrop) with Approve+sweep to a fresh recipient; expect TOKEN_DELEGATE_APPROVE + sweep flags.
- **Sources:** https://www.cryptopolitan.com/fake-jupiter-aidrop-jupuary-wallet-drainer/, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676, https://decrypt.co/212875/hackers-steal-over-4-million-fake-airdrops-other-scams-solana

### TOCTOU / conditional-state simulation evasion

#### Bitflip attack (post-signature conditional flip) - Aqua / Vanish
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: SIM_INFLOW_BUT_WRITABLE_TO_FOREIGN (shared): flag simulated inflow with operator-mutable state account + sign-to-broadcast delay.
- **Mechanism:** After signing, drainer WITHHOLDS the tx, lands a separate tx flipping a conditional in the dApp's state ('send SOL to user' -> 'seize SOL'), then broadcasts the withheld tx to drain. Sold scam-as-a-service.
- **On-chain signature:** Signed tx whose target program behavior depends on a mutable account/data field controlled by the program authority; drain manifests as outflow despite a simulated inflow; delay between signature and broadcast.
- **Real incidents:** Aqua & Vanish (Blowfish, Feb 9 2025): manipulate on-chain conditionals after signing; scam-as-a-service
- **Benchmark fixture:** Tx simulating an inflow but depending on an operator-controlled state account; expect UNKNOWN_PROGRAM + inflow-mismatch.
- **Sources:** https://crypto.news/blowfish-exposes-aqua-vanish-bit-flip-drainers-solana/, https://cointelegraph.com/news/scam-as-a-service-new-solana-drainers-identified, https://www.blockaid.io/blog/bypasses-how-attackers-evade-transaction-simulation

### TOCTOU / post-signature manipulation

#### TOCTOU bit-flip drainers (Aqua / Vanish): post-signature state flip
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: TOCTOU_STATE_GATED_UNKNOWN_PROGRAM (shared): flag unverified programs reading attacker-mutable state + durable-nonce delay; recommend post-state assertions.
- **Mechanism:** Hidden conditional resolves benign at sim; after signing, attacker flips an account/state byte in a separate tx, then submits the original signature. Vanish: mint CPMbUt3SSoeoCJGCzhqmy7ZoaHWqd8AQPTvYiNeSxatt, 7-block gap, ~$3,000.
- **On-chain signature:** Unverified custom program (no IDL); attacker-controlled writable account read as a conditional; durable-nonce enabling delayed submission. Static+dynamic analysis required.
- **Real incidents:** Blowfish (Feb 9 2024): Aqua/Vanish bit-flip drainers; Blockaid: Vanish ~$3,000, mint CPMbUt3...xatt, state-set 7 blocks ahead
- **Benchmark fixture:** Tx invoking an unverified program that reads a writable attacker account, using a durable nonce; expect UNKNOWN_PROGRAM + TOCTOU + DURABLE_NONCE flags.
- **Sources:** https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing, https://crypto.news/blowfish-exposes-aqua-vanish-bit-flip-drainers-solana/, https://cointelegraph.com/news/scam-as-a-service-new-solana-drainers-identified

### TOCTOU / simulation evasion

#### TOCTOU state-condition trigger (benign-in-simulation, drains on execute)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: TOCTOU_STATE_GATED_UNKNOWN_PROGRAM (shared): flag unverified programs that branch on external state and any account an attacker can pre-create/pre-set.
- **Mechanism:** Branch gated on state FALSE at sim time; benign path runs (NFT mint/tiny transfer/no-op). After sign attacker lands a setup tx flipping state, then the victim's signed tx drains. Vanish: token account for mint CPMbUt3...xatt.
- **On-chain signature:** Top-level CPI to an unverified (no IDL) program reading an attacker-controllable account; a benign-looking instruction (NFT mint, small SOL transfer) sharing the same opaque program.
- **Real incidents:** Blockaid Vanish TOCTOU (2024): mint CPMbUt3...xatt, ~$3,000, 7 blocks; Scam-as-a-service kits to bypass any simulation (Feb 20 2024, Mikko Ohtamaa)
- **Benchmark fixture:** Tx with a small-transfer instruction and an unverified program reading a pre-creatable account; expect UNKNOWN_PROGRAM + TOCTOU.
- **Sources:** https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing, https://www.blockaid.io/blog/bypasses-how-attackers-evade-transaction-simulation, https://coinpaper.com/3392/wallet-drainer-promises-to-bypass-any-transaction-simulation-now-available-for-sale

### TOCTOU against post-state indexers

#### False top-up / deposit-credit spoof via token-account ownership reassignment
`high` · sim-detectable: **partial** · irreversible: **False** · coverage: **partial** → suggest: INTRA_TX_SETAUTHORITY_WITH_WASH_TRANSFER (shared): reconstruct intra-transaction ownership per transfer, not just final owner.
- **Mechanism:** Six-step atomic tx: create temp attacker-owned token account, init, transfer in, wash out (net zero), SetAuthority to a deposit address, finalize so indexers reading final state mis-credit a deposit.
- **On-chain signature:** One tx with CreateAccount/InitializeAccount, Transfer(s) in+out netting ~zero, then SetAuthority(AccountOwner) reassigning to a deposit address; downstream apparent balance change without a platform-initiated tx.
- **Real incidents:** Liminal Custody (Feb 2026): two low-value false top-up probes neutralized; no funds lost
- **Benchmark fixture:** Six-step atomic create/init/transfer-in/out/SetAuthority tx; expect SET_AUTHORITY + false-top-up flag.
- **Sources:** https://www.liminalcustody.com/blog/how-the-solana-false-top-up-attack-works-and-how-to-stop-it/

### Token-2022 extension abuse

#### Token-2022 Permanent Delegate burn/transfer (no victim signature)
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: TOKEN2022_PERMANENT_DELEGATE: at swap/quote time parse the mint's extension TLV and flag any non-null PermanentDelegate (type 12); warn the position is seizable without further signature.
- **Mechanism:** PermanentDelegate mint extension grants an authority unconditional, unrevocable power to Transfer/Burn any holder's tokens without the holder's signature. RED token burned a buyer's tokens ~7s after purchase.
- **On-chain signature:** Pre-sign: mint TLV has PermanentDelegate (extension type 12) with non-null delegate. Theft tx: Burn/BurnChecked/TransferChecked where signing authority == mint permanent delegate, not the token-account owner.
- **Real incidents:** RED token (~Aug 30 2024): burned a Jupiter member's tokens ~7s after purchase; documented by Slorg, PeckShield, Beosin; Token-2022 permanent-delegate abuse Q1 2026 with ~$50M+ estimated losses
- **Benchmark fixture:** Swap into a Token-2022 mint whose TLV has PermanentDelegate set; expect TOKEN2022_PERMANENT_DELEGATE=critical.
- **Sources:** https://www.tradingview.com/news/cointelegraph:13ab18ce1094b:0-scammers-have-found-a-way-to-burn-tokens-from-inside-solana-wallets/, https://coinpaper.com/5295/scammers-exploit-solana-token-feature-to-burn-users-crypto, https://dev.to/ohmygod/solanas-permanent-delegate-burn-scam-how-token-2022-extensions-power-2026s-largest-automated-rug-4579

### Token-2022 extension abuse - arbitrary code on transfer

#### Transfer Hook honeypot (sell-blocking via mid-transfer revert)
`high` · sim-detectable: **yes** · irreversible: **False** · coverage: **gap** → suggest: TOKEN2022_TRANSFER_HOOK: flag any non-null transfer_hook_program_id (type 14) and resolve the hook program; warn it runs arbitrary code on the user's transfer/sell.
- **Mechanism:** TransferHook (extension type 14) CPIs into an attacker program on every transfer_checked; the hook reverts on sells for non-whitelisted accounts, producing a buy-only honeypot. Hook can be changed by its config authority.
- **On-chain signature:** Mint TLV carries TransferHook (type 14) with non-null transfer_hook_program_id; an ExtraAccountMetaList PDA enumerates injected accounts. Resolve the hook program and note it executes on the user's pending sell.
- **Real incidents:** Commercial honeypot kits (CryptoKoki, solanahoneypotscript.com) productize sell-blocking with deployer whitelists (2024-2025; mostly freeze-based); Neodyme (2024): transfer-hook abuse incl. malicious extra-account injection
- **Benchmark fixture:** Swap into a Token-2022 mint with a TransferHook program set; expect TOKEN2022_TRANSFER_HOOK=high.
- **Sources:** https://github.com/cryptokoki-services/solana-honeypot-token, https://solana.com/developers/guides/token-extensions/transfer-hook, https://neodyme.io/en/blog/token-2022/, https://dev.to/ohmygod/solanas-token-2022-transfer-hooks-how-a-safe-feature-imported-ethereums-deadliest-bug-class-16p6

### Token-2022 extension abuse - authority-based seizure

#### Permanent Delegate post-sign burn/transfer (RED token rug factory)
`critical` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: TOKEN2022_PERMANENT_DELEGATE (shared): parse mint extension TLV at swap/quote time and flag any non-null PermanentDelegate (type 12).
- **Mechanism:** PermanentDelegate (extension type 12) grants a fixed authority unconditional, non-revocable Burn/TransferChecked over every holder of the mint without signature; victim's balance burned ~7-60s after a swap. Industrialized as a token factory.
- **On-chain signature:** Mint TLV contains PermanentDelegate (type 12) with non-null delegate; the drain is a SEPARATE later Burn/BurnChecked/TransferChecked signed by the permanent delegate, not the owner. Key on token-account authority != fee payer + mint has PermanentDelegate.
- **Real incidents:** RED token (~Sept 3 2024): Slorg-documented burn to zero ~7s after swap; PeckShield/Beosin confirmed (Sept 2024); Industrial permanent-delegate burn factories 2025-2026; RugCheck flags a large share of new Token-2022 mints
- **Benchmark fixture:** Swap into a Token-2022 mint with PermanentDelegate set; expect TOKEN2022_PERMANENT_DELEGATE=critical.
- **Sources:** https://www.tradingview.com/news/cointelegraph:13ab18ce1094b:0-scammers-have-found-a-way-to-burn-tokens-from-inside-solana-wallets/, https://www.binance.com/en/square/post/2024-09-04-scammers-exploit-solana-token-extension-to-burn-users-crypto-13074543469010, https://neodyme.io/en/blog/token-2022/, https://www.cryptotimes.io/2024/09/04/scammers-burn-solana-tokens-seconds-after-purchase/

### Token-2022 extension abuse - cryptographic proof bypass

#### Confidential Transfer ZK ElGamal proof forgery (Fiat-Shamir soundness bugs)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **gap** → suggest: CONFIDENTIAL_TRANSFER_OPAQUE: when a mint has ConfidentialTransfer / the ZK ElGamal Proof program is invoked, warn that transfer amounts are opaque to read-only review; treat encrypted-amount instructions as un-simulatable.
- **Mechanism:** ZK ElGamal Proof program soundness bugs (Apr 2025 missing transcript components; June 2025 'Phantom Challenge' missing c_max_proof absorption) let a prover forge proofs to mint unlimited tokens, withdraw from any confidential account, or zero fees. The extension also structurally hides transfer amounts.
- **On-chain signature:** Mint TLV has ConfidentialTransferMint; tx invokes the ZK ElGamal Proof program (ZkE1Gama1Proof11111111111111111111111111111) for VerifyTransfer/VerifyWithdraw plus encrypted Deposit/Withdraw/Transfer; amounts are opaque to a reviewer.
- **Real incidents:** ZK ElGamal zero-day (reported Apr 16 2025 by 'LonelySloth'; patched ~48h): forged proofs could mint unlimited / withdraw from any account; Phantom Challenge soundness bug (June 2025, zksecurity): forged fee/transfer proofs
- **Benchmark fixture:** Tx invoking ZkE1Gama1Proof... with confidential Withdraw; expect CONFIDENTIAL_TRANSFER_OPAQUE warning.
- **Sources:** https://solana.com/news/post-mortem-may-2-2025, https://blog.zksecurity.xyz/posts/solana-phantom-challenge-bug/, https://solana.com/news/post-mortem-june-25-2025, https://neodyme.io/en/blog/token-2022/

### Token-2022 extension abuse - freeze-state control

#### Default Account State = Frozen honeypot
`high` · sim-detectable: **yes** · irreversible: **True** · coverage: **gap** → suggest: TOKEN2022_DEFAULT_FROZEN: flag mints with DefaultAccountState=Frozen (type 6) + non-null freeze authority; warn new ATAs are unmovable.
- **Mechanism:** DefaultAccountState (extension type 6) initializes every new token account Frozen; only the freeze authority can thaw. Buyers hold an unmovable balance; worst case operator freezes all then abandons the authority (permanent).
- **On-chain signature:** Mint TLV carries DefaultAccountState (type 6) with state=Frozen AND a non-null freezeAuthority; holder ATAs show state Frozen (2). Flag default-frozen mints and any FreezeAccount by the freeze authority on a user ATA.
- **Real incidents:** 'Frozen token account' honeypot class (Solscan; Chainstack Token-2022 guide, 2024-2026); Neodyme (2024): default-frozen accounts as DoS/lock vector
- **Benchmark fixture:** Swap into a default-frozen Token-2022 mint with live freeze authority; expect TOKEN2022_DEFAULT_FROZEN=high.
- **Sources:** https://info.solscan.io/what-is-a-frozen-token-account/, https://solana.com/developers/guides/token-extensions/default-account-state, https://chainstack.com/solana-token-2022-utility-extensions/, https://neodyme.io/en/blog/token-2022/

### Token-2022 extension abuse - mint lifecycle manipulation

#### Mint Close Authority reinit / orphan-account extension bypass
`medium` · sim-detectable: **partial** · irreversible: **False** · coverage: **gap** → suggest: TOKEN2022_MINT_CLOSE_AUTHORITY: flag mints with a MintCloseAuthority (type 3); re-parse the full extension set at sign time and never cache mint properties by address alone.
- **Mechanism:** MintCloseAuthority (type 3) lets an authority close a zero-supply mint, then re-init the SAME address with hostile extensions, defeating allowlists keyed on the mint address; orphaned token accounts bypass new extension requirements (KYC, fee).
- **On-chain signature:** Mint TLV carries MintCloseAuthority (type 3) with a close authority; signal: CloseAccount on a mint then a re-InitializeMint at the same pubkey with a changed extension set. Re-parse mint TLV at sign time (not cache).
- **Real incidents:** Neodyme (2024): mint-close reinitialization and orphan-account bypass of KYC/transfer-fee requirements
- **Benchmark fixture:** Mint with MintCloseAuthority set; expect TOKEN2022_MINT_CLOSE_AUTHORITY=medium + no-cache warning.
- **Sources:** https://neodyme.io/en/blog/token-2022/, https://solana.com/docs/tokens/extensions

### Token-2022 extension abuse - permanent non-liquidity

#### Non-Transferable (soulbound) lock-in / unsellable airdrop
`medium` · sim-detectable: **yes** · irreversible: **True** · coverage: **gap** → suggest: TOKEN2022_NON_TRANSFERABLE: flag mints with NonTransferable (type 9) as unsellable before a user buys/accepts.
- **Mechanism:** NonTransferable makes a token soulbound: holders can never transfer, only burn. Used for guaranteed-unsellable positions, fake holdings, or pairing with off-chain promises. Mint extension is type 9; holder ATAs carry NonTransferableAccount (type 13).
- **On-chain signature:** Mint TLV carries NonTransferable (extension type 9); holder ATAs carry NonTransferableAccount (type 13). Any TransferChecked of such a mint fails; only Burn is permitted.
- **Real incidents:** Documented 'lock-in scam'/unsellable-token vector in Token-2022 writeups (2024-2026); Neodyme notes low integrator risk; Chainstack/Ledger guidance: check non-transferable before acquiring
- **Benchmark fixture:** Swap into a NonTransferable Token-2022 mint; expect TOKEN2022_NON_TRANSFERABLE=medium.
- **Sources:** https://neodyme.io/en/blog/token-2022/, https://support.ledger.com/article/Solana-Token-Extensions, https://chainstack.com/solana-token-2022-utility-extensions/, https://dev.to/ohmygod/solana-token-2022-security-the-hidden-attack-surface-in-token-extensions-every-defi-protocol-must-1jke

### Token-2022 extension abuse - value skim on transfer

#### Transfer Fee extension surprise/extractive fee (up to 100% withheld)
`medium` · sim-detectable: **yes** · irreversible: **False** · coverage: **gap** → suggest: TOKEN2022_TRANSFER_FEE: surface current + scheduled transfer_fee_basis_points; flag fees near 10000 bps and any pending newer/older fee mismatch.
- **Mechanism:** TransferFeeConfig (type 1) withholds a basis-point fee (up to 10000 = 100%) on every transfer, accrued on the recipient ATA (type 2). Fee can be set low at listing then raised via the fee authority (2-epoch schedule). Withheld balances block account closure.
- **On-chain signature:** Mint TLV TransferFeeConfig (type 1) exposing transfer_fee_basis_points, maximum_fee, fee/withdraw authority; recipient ATAs accrue TransferFeeAmount (type 2). Surface current AND newer scheduled bps; flag fees near 10000 bps and SetTransferFee.
- **Real incidents:** Neodyme (2024): transfer-fee mis-accounting and account-close lock risks; Solana docs/Chainstack: recipient-side withholding + authority-controlled fee changes
- **Benchmark fixture:** Swap into a Token-2022 mint with transfer_fee_basis_points=10000; expect TOKEN2022_TRANSFER_FEE=medium/high.
- **Sources:** https://solana.com/docs/tokens/extensions/transfer-fees, https://neodyme.io/en/blog/token-2022/, https://chainstack.com/solana-token-2022-fee-transfer-hooks/

### Token-extension drainer / rug mechanism

#### Token-2022 Permanent Delegate burn / seize rug factory
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: TOKEN2022_PERMANENT_DELEGATE (shared).
- **Mechanism:** PermanentDelegate mint extension lets a mint-level authority transfer/burn ANY holder's tokens, unrevocable; seconds after a buy the operator burns/seizes. RugCheck flags 40%+ of new Solana tokens with the extension.
- **On-chain signature:** Pre-sign: mint carries PermanentDelegate (and often non-transferable/transfer-hook/default-frozen). get_permanent_delegate(mint) set to non-null non-user authority. Post-buy: Burn/TransferChecked signed by the permanent delegate, not the owner.
- **Real incidents:** Token-2022 PermanentDelegate burn-scam factory (March 2026); RugCheck flags 40%+ of new tokens; RED token ~7s burn
- **Benchmark fixture:** Swap into a Token-2022 mint with non-null permanent delegate; expect TOKEN2022_PERMANENT_DELEGATE=high.
- **Sources:** https://dev.to/ohmygod/solanas-permanent-delegate-burn-scam-how-token-2022-extensions-power-2026s-largest-automated-rug-4579, https://solana.com/developers/guides/token-extensions/permanent-delegate

### Vanity-address spoofing

#### ISA — vanity addresses mimicking system programs ('...1111' / 'Compu...')
`medium` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: SYSTEM_ACCOUNT_IMPERSONATION (shared).
- **Mechanism:** Grind vanity addresses sharing prefix/suffix of system accounts; trick victims into sending/signing to the lookalike. SolPhishHunter ISA rule fires on beneficiary 'Compu.*' OR '.*1111'; $75,701.98; CaNC...1111 1,692 attempts.
- **On-chain signature:** Destination/authority is a non-canonical vanity address whose prefix/suffix matches a real program/account but is not the canonical program ID; near-miss against the system-program allowlist.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): $75,701.98 ISA; CaNC...1111 1,692 attempts; lookalike CompuV3LmCTW7AG...; Scam Sniffer (Feb 3 2024) system-program suffix grinding
- **Benchmark fixture:** Transfer to a 'Compu...' vanity EOA; expect SYSTEM_ACCOUNT_IMPERSONATION=medium.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676

### Wallet/infrastructure compromise (off-chain key theft)

#### Slope Wallet private-key exfiltration (Sentry logging leak)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: BEHAVIORAL_SWEEP_HEURISTIC: since the tx is legitimately signed, key only on sudden full-balance sweep to a fresh/never-paid recipient; surface as a soft warning (cannot block a valid signature).
- **Mechanism:** Slope logged seed mnemonics in plaintext to a Sentry server; attacker reconstructed keys and signed ordinary valid transfers, indistinguishable from normal user activity.
- **On-chain signature:** No anomalous instruction: standard System/SPL transfers correctly signed by the rightful owner, draining to a few collectors in a 4-hour window (2022-08-02 22:37 UTC+). Only behavioral heuristics (sudden full-balance sweep to a fresh address) apply.
- **Real incidents:** Slope Wallet 2022-08-02/03: ~9,231 wallets drained, ~$4.1M (MistTrack est. up to ~$580M incl. illiquid EXIST)
- **Benchmark fixture:** Valid owner-signed full-balance SOL sweep to a fresh address; expect LARGE_SOL_OUTFLOW + behavioral warning.
- **Sources:** https://solana.com/news/8-2-2022-application-wallet-incident, https://www.coindesk.com/business/2022/08/03/solanas-latest-6m-exploit-likely-tied-to-slope-wallet-devs-say, https://ackee.xyz/blog/2022-solana-hacks-explained-slope-wallet/, https://blog.sentry.io/slope-wallet-solana-hack/

### address-poisoning

#### Address poisoning via lookalike (vanity-grind) recipients
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **gap** → suggest: LOOKALIKE_RECIPIENT (shared): prefix+suffix / Levenshtein similarity vs historical recipients; flag recipients whose only history is a dust seed.
- **Mechanism:** Vanity address matching leading/trailing chars of a frequent recipient; dust seed in history; victim copy-pastes and sends a large transfer. The poisoning transfer is an ordinary transfer; the danger is the eventual outbound to the lookalike.
- **On-chain signature:** A transfer whose destination shares a long matching prefix+suffix with a known prior counterparty but differs in the middle, and/or a destination that only ever appeared via a sub-dust inbound; large outflow to a never-before-paid address that 'looks like' a known one.
- **Real incidents:** May 2024 WBTC $68M whale 0x1E227 (technique ported to Solana); 82,031 seeded lookalikes over 66 days (Feb 28-May 4 2024), ~$1.49M (Chainalysis); Nov 2024 Solana $2.91M copied spoofed CEX address; Aug 2025 wave >$1.6M/week (unverified)
- **Benchmark fixture:** Large outflow to a prefix+suffix match of a CEX address differing in the middle; expect LOOKALIKE_RECIPIENT=critical.
- **Sources:** https://www.chainalysis.com/blog/address-poisoning-scam/, https://u.today/solana-sol-users-targeted-in-new-address-poisoning-attack-details, https://pineanalytics.substack.com/p/solana-account-dusting-and-address, https://arxiv.org/html/2505.04094v1

#### Impersonation of System Accounts (ISA) — fake 'Compu...'/...1111 recipients
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: SYSTEM_ACCOUNT_IMPERSONATION (shared).
- **Mechanism:** Grind vanity addresses mimicking system/program accounts ('Compu' prefix, '1...' suffix); phishing dApp builds a Transfer to the counterfeit address and the victim, recognizing the familiar pubkey, signs and is depleted.
- **On-chain signature:** Transfer + fund depletion where recipient matches /Compu.*/ or /.*1111/ (or mimics a canonical program/system address) yet is not byte-equal. Maintain a canonical program-ID allowlist and flag visually-close non-equal recipients.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): 3,449 ISA txs, $75,701.98, $21.95 avg, Jan-Jun 2024; CaNC...1111: 1,692 attempts, $43,547
- **Benchmark fixture:** Transfer to a /Compu.*/ vanity recipient; expect SYSTEM_ACCOUNT_IMPERSONATION=high.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://arxiv.org/abs/2505.04094

#### Domain/vanity dust poisoning (off-chain redirect lures)
`medium` · sim-detectable: **partial** · irreversible: **False** · coverage: **gap** → suggest: UNSOLICITED_DUST_INTERACTION: flag outbound transfer/burn/approve on an asset that arrived unsolicited as dust and was never acquired by the agent; key on MEMO_PRESENT with domain/URL patterns.
- **Mechanism:** Spam wallets with uneconomical micro/zero-value transfers and fake-named tokens ('flip.gg', 'casino.sol') so the strings surface in history/asset lists; goal is redirecting to off-chain sites or baiting interaction with the dust token (may trigger a malicious program).
- **On-chain signature:** Unsolicited sub-economic inbound transfers, fake mints with URL/brand-like names/symbols, or memo/name fields embedding domains. Flag any OUTBOUND interaction with an asset that arrived unsolicited as dust; never auto-interact.
- **Real incidents:** Pine Analytics (Apr 2025): domain-named dust campaigns (flip.gg, OdinBot.io); Phantom guidance: don't transfer/burn unsolicited dust tokens
- **Benchmark fixture:** Outbound burn of a fake-named dust token never acquired; expect UNSOLICITED_DUST_INTERACTION=medium.
- **Sources:** https://pineanalytics.substack.com/p/solana-account-dusting-and-address, https://x.com/PineAnalytics/status/1915541130210664859, https://paragraph.com/@wild-tales/account-dusting-and-poisoning-on-solana

### closeAccount rent-reclaim sweep

#### closeAccount rent-reclaim + WSOL-unwrap sweep
`high` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `CLOSE_TOKEN_ACCOUNT`)
- **Mechanism:** After draining a token account, append closeAccount (index 9) sending the rent-exempt deposit to an attacker; WSOL accounts can be closed with non-zero balance to unwrap and sweep underlying lamports.
- **On-chain signature:** closeAccount where destination (account index 1) != owner (index 2), especially paired with preceding full-balance transfers and/or a WSOL ATA being closed.
- **Real incidents:** SolPhishHunter STMT campaigns (2024, arXiv:2505.04094) chain transfer + account-clearing; SPL Token closeAccount semantics (Solana Foundation docs)
- **Benchmark fixture:** Tx closing a WSOL ATA with destination=attacker; expect CLOSE_TOKEN_ACCOUNT=high (rent/WSOL sweep).
- **Sources:** https://solana.com/docs/tokens/basics/close-account, https://spl.solana.com/token, https://arxiv.org/html/2505.04094v1

### fee-resource

#### Priority-fee / compute-budget draining and spam griefing
`medium` · sim-detectable: **yes** · irreversible: **True** · coverage: **partial** → suggest: Strengthen COMPUTE_BUDGET_SET + HIGH_FEE to cap absolute priority-fee lamports, flag CU limit near 1,400,000, and gate when fee/notional ratio exceeds a threshold; flag repeated failing txs.
- **Mechanism:** An agent auto-setting SetComputeUnitPrice/SetComputeUnitLimit from naive estimates can be griefed into overpaying during spam floods; CU limit can be pushed toward 1.4M or CU price set extreme, draining SOL per tx. SIMD-0096 routes 100% of priority fees to validators (non-recoverable). Base fee charged on failed txs.
- **On-chain signature:** ComputeBudget SetComputeUnitPrice with an outsized micro-lamport price, SetComputeUnitLimit near 1,400,000, or a priority fee large relative to tx value. Cap absolute priority-fee lamports and CU limit; compare fee to notional; loops of failing txs are a drain signal.
- **Real incidents:** April 2024 congestion: ~75-80% non-vote tx failure (75.3% Apr 4); ORE ~25% of TPS; Anza v1.17.31 fix Apr 15 2024; Sandwich/MEV bots ~$370M-$500M over 16 months ('protection fees'); SIMD-0096 (Feb 2025): 100% of priority fees to validators
- **Benchmark fixture:** Tx SetComputeUnitPrice outsized + CU limit ~1,400,000 on a low-value swap; expect COMPUTE_BUDGET_SET + HIGH_FEE=medium.
- **Sources:** https://crypto.news/solana-network-plagued-by-bot-spams-record-number-of-transactions-fail/, https://www.coindesk.com/tech/2024/04/15/solana-rolls-out-update-to-tackle-network-congestion, https://www.gate.com/learn/articles/solana-sandwich-attacks-make-a-comeback-priority-fees-turn-into-protection-fees-and-the-on-chain-dark-cycle-escalates/7668, https://solana.com/docs/core/fees/compute-budget

### malicious-token

#### Token-2022 permanent-delegate / transfer-hook honeypot tokens
`high` · sim-detectable: **partial** · irreversible: **True** · coverage: **gap** → suggest: TOKEN2022_EXTENSION_SCAN: at swap/acquire time parse the full mint extension TLV and gate on PermanentDelegate / TransferHook / NonTransferable / live FreezeAuthority / ConfidentialTransfer.
- **Mechanism:** Malicious Token-2022 mints ship abusive extensions: PermanentDelegate (seize/burn any holder), TransferHook (revert sells), NonTransferable (lock-in), ConfidentialTransfer (hide dumps), FreezeAuthority (freeze others). An agent holding such a token can have it burned/frozen.
- **On-chain signature:** Mint owned by Token-2022 (TokenzQd...) carrying PermanentDelegate, TransferHook, NonTransferable, or live FreezeAuthority. Parse the mint extension TLV before any swap/acquire; post-acquire drains appear as Transfer/Burn signed by the permanent delegate.
- **Real incidents:** Neodyme: permanent-delegate/transfer-hook abuse surface; 2026: permanent-delegate burn-scam factory, Q1 2026 $50M+ (forward-dated/unverified); RugCheck >40% of new tokens (unverified); Freeze-authority meme-token rug pattern (Phantom frozen-tokens doc)
- **Benchmark fixture:** Swap into a Token-2022 mint carrying PermanentDelegate + TransferHook; expect TOKEN2022_EXTENSION_SCAN=high.
- **Sources:** https://neodyme.io/en/blog/token-2022/, https://dev.to/ohmygod/solanas-permanent-delegate-burn-scam-how-token-2022-extensions-power-2026s-largest-automated-rug-4579, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676, https://help.phantom.com/hc/en-us/articles/29763090277139-What-are-frozen-tokens-on-Solana

### ownership-transfer

#### Account Authority Transfer (AAT) — SetAuthority/Assign ownership theft
`critical` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `SET_AUTHORITY`)
- **Mechanism:** Transfers OWNERSHIP instead of tokens: SetAuthority authorityType=AccountOwner (or Approve delegate) on a token account, or System Assign on a wallet. Malicious tx may move $0; theft happens later. Highest-loss class.
- **On-chain signature:** SPL-Token SetAuthority (authorityType=AccountOwner/CloseAccount), Approve/ApproveChecked granting a delegate, or System Assign changing account ownership away from the signer. Hard-gate any instruction mutating owner/close/delegate authority on the signer's own accounts.
- **Real incidents:** SolPhishHunter (arXiv:2505.04094): 2,171 AAT txs, $812,219 ($374.12 avg) = 73.85%; BNRT...5Rep 931 authority-transfer txs; GoPlus/Scam Sniffer: SPL approve/authority-transfer phishing as a primary Solana drainer vector
- **Benchmark fixture:** Tx with SetAuthority(AccountOwner) or Assign or unlimited Approve on signer's accounts; expect critical AUTHORITY_HANDOVER.
- **Sources:** https://arxiv.org/html/2505.04094v1, https://goplussecurity.medium.com/exposing-solana-scammers-scams-and-phishing-b5a4e0ca2676, https://coinpedia.org/news/solana-wallets-caught-in-a-phishing-signature-attacks/

### sol-outflow

#### Single-Transaction Multi-Transfer drain (STMT) — CLINKSINK/Rainbow/Node
`critical` · sim-detectable: **yes** · irreversible: **True** · coverage: **covered** (rule: `FULL_TOKEN_ACCOUNT_DRAIN`)
- **Mechanism:** Kits build ONE tx bundling multiple Transfer instructions (System.transfer SOL + several SPL transfers) draining multiple assets to zero in one signature; ~80/20 split in config.
- **On-chain signature:** >2 transfers in one tx emptying 2+ token types to zero, recipients = attacker wallet(s); many SPL Transfers draining ATAs to 0 + a near-full SOL System transfer; optional CloseAccount to sweep rent.
- **Real incidents:** CLINKSINK (Mandiant/Google, Dec 2023-Jan 2024): >=$900K; >=35 affiliate IDs, 42 wallets; operator B8Y1dERnVNoUUXeXA4NaCHiB9htcukMSkfHrFsTMHA7h; Rainbow ~$2.14M / 2,189; Node >$2M / 1,759; ~$4.17M combined; SolPhishHunter STMT: 2,438 txs, $211,894, peak March 2024; Gck5...1VX4 1,639 txs; Q2 2025: >$87M drained
- **Benchmark fixture:** One tx draining 3 ATAs to zero + SOL + CloseAccount to attacker; expect FULL_TOKEN_ACCOUNT_DRAIN + MULTI_ASSET_SWEEP=critical.
- **Sources:** https://cloud.google.com/blog/topics/threat-intelligence/solana-cryptocurrency-stolen-clinksink-drainer-campaigns, https://cointelegraph.com/news/scam-as-a-service-new-solana-drainers-identified, https://arxiv.org/html/2505.04094v1, https://cyble.com/blog/solana-drainers-source-code-saga-tracing-its-lineage-to-the-developers-of-ms-drainer/

#### Bit-flip / post-signature transaction mutation (Aqua, Vanish)
`critical` · sim-detectable: **no** · irreversible: **True** · coverage: **partial** → suggest: POST_SIGN_STATE_MUTATION_RISK (shared) + CONDITIONAL_EFFECT_REFUSAL: refuse to sign txns whose effect depends on mutable state.
- **Mechanism:** Victim signs a benign-simulating tx; drainer holds the signature and bit-flips the encrypted/conditional on-chain data so the executed effect inverts (transfer-in becomes drain) without the key. Reviewed message != executed message.
- **On-chain signature:** Hard to key on at review time. Defensive: refuse txns whose effect is conditional on mutable on-chain state; require fully-specified amounts/recipients; re-validate the landed tx against the approved one; flag durable-nonce delay.
- **Real incidents:** Blowfish (Feb 9 2024): Aqua/Vanish bit-flip drainers altering a signed tx's effect post-signature; SolPhishHunter: 14 STMT txns abused advanceNonce for delayed execution
- **Benchmark fixture:** Tx whose effect depends on a mutable conditional account; expect UNKNOWN_PROGRAM + conditional-effect warning.
- **Sources:** https://crypto.news/blowfish-exposes-aqua-vanish-bit-flip-drainers-solana/, https://cointelegraph.com/news/scam-as-a-service-new-solana-drainers-identified, https://arxiv.org/html/2505.04094v1
