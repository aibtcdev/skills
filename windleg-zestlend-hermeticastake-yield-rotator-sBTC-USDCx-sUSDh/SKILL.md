---
name: windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh
description: "Wind-only yield rotator: supply sBTC on Zest, borrow USDCx on Zest, swap USDCx->USDh on Bitflow Quote Engine (viability-gated), stake USDh inline on Hermetica staking-v1-1 (returns sUSDh). Score gates entry; monitor (HITL or autonomous, 1-action/24h cap) detects when conditions become viable; outputs UNWIND signal for the partner unwinder skill but never broadcasts unwind itself."
metadata:
  author: "IamHarrie-Labs"
  author-agent: "Serene Spring"
  user-invocable: "false"
  arguments: "doctor | status | score | plan | run | resume | monitor | cancel"
  entry: "windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh/windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts"
  requires: "wallet, signing, settings, zest-asset-deposit-primitive, zest-borrow-asset-primitive, bitflow-swap-aggregator"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Wind-Leg: ZestLend → HermeticaStake Yield Rotator

## Scope

Wind-only. Four legs in order:

1. Supply sBTC into Zest V2 — shells out to `zest-asset-deposit-primitive`.
2. Borrow USDCx against the sBTC — shells out to `zest-borrow-asset-primitive`.
3. Swap USDCx → USDh via Bitflow's DLMM Quote Engine — shells out to `bitflow-swap-aggregator`.
4. **Stake USDh on Hermetica `staking-v1-1` — inline in this skill's own `.ts`. Wallet receives sUSDh.** Broadcast via `@stacks/transactions`, signed via the canonical AIBTC wallet pipeline (see "Signer" below).

The reverse path is the **companion `unwinder` skill's** job, in a separate PR. This skill emits `UNWIND_RECOMMENDED` signals but never broadcasts unwind.

## Asset journey

| Step | Wallet receives | Wallet sends | On-chain effect |
|---|---|---|---|
| Supply | (Zest collateral credit) | sBTC | sBTC -> Zest market-vault as collateral |
| Borrow | USDCx | (Zest debt position) | Zest market mints USDCx debt against the sBTC collateral |
| Swap | USDh | USDCx | Bitflow aggregator routes USDCx -> USDh via whichever USDh venue gives the best quote at the requested size — typically `BITFLOW_STABLE_XY_4` (stableswap `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.stableswap-swap-helper-v-1-5`) for small sizes, `dlmm_8` for sizes that move the stableswap pool. The skill does not pin a route; it accepts whichever venue the aggregator selects. |
| **Stake** | **sUSDh** | **USDh** | **Hermetica `staking-v1-1.stake` transfers USDh to staking-reserve-v1 and mints sUSDh to the caller via `susdh-token-v1.mint-for-protocol`** |

The skill name spells the start-and-end of this journey: **sBTC** (in) -> **USDCx** (debt) -> **sUSDh** (out).

## What it does

Runs the four-leg wind path under operator control or autonomously. The strategy module (`score`) evaluates six components — BTC regime, Binance perp funding 7d MA, post-borrow-impact carry spread (sUSDh APY − projected USDCx borrow APR), carry trend, BTC realized vol, USDh peg via Bitflow Quote Engine — into a 0–100 composite. Default thresholds: enter at composite ≥ 55, signal unwind at composite < 35. The `--max-price-impact-bps` gate (default 50 bps) refuses the swap leg when the active DLMM bin can't absorb the operator's projected size.

## Why agents need it

USDh staking yield is denominated in USD; most agents on Stacks hold sBTC. Without this skill, the operator runs four independent decisions with four checkpoints. With it, the operator gets one auditable rotation, a single checkpoint, an explicit `resume` path, and a strategy layer that monitors viability so the agent only acts when conditions actually favor entering. The result: a wallet holding **sUSDh** — yield-bearing dollar exposure financed by sBTC collateral.

## Verified empirical conditions at submission time

(Subject to change — re-run `score` to refresh.)

| Source | Reading | Implication |
|---|---|---|
| Zest sBTC supply APY | 1.69% | Collateral leg yield |
| Zest USDCx borrow APR | 1.82% | Debt leg cost |
| Hermetica sUSDh APY | 8.0% (Hermetica Earn UI; daily-distributed via exchange-rate appreciation) | Stake leg yield |
| **Net carry at LTV 0.40** | ~4.16% in sBTC terms | Worth running |
| Bitflow USDh/USDCx venues | `dlmm_8` DLMM pool (~$400 TVL at submission) + `BITFLOW_STABLE_XY_4` stableswap (the aggregator selects between them at quote time) | Aggregator-routed; small sizes route stableswap, larger sizes route DLMM |
| Quote Engine price impact: 5 / 20 / 100 USDCx → USDh | 0 / 0 / 0 bps | **Viable today at small sizes** |
| Quote Engine price impact: 1,000 USDCx | 6,136 bps | Not viable at this size today |

The viability gate is the value proposition — the skill detects when the pool can absorb the operator's projected size and refuses when it can't.

## Strategy components and weights

| Component | Weight | Input | 100 → 0 mapping |
|---|---|---|---|
| BTC regime | 25% | BTC 7d + 30d return (CoinGecko market_chart) | 7d up ≥+5% → 100; 7d down ≥−10% → 0 |
| Funding rate (7d MA) | 20% | Binance BTCUSDT `fundingRate` last 21 prints, annualized | annualized ≥ +12% → 100; ≤ 0% → 0 |
| Carry spread (post-borrow-impact) | 15% | sUSDh APY − projected USDCx borrow APR at my size | spread ≥ +10% → 100; ≤ 0% → 0 |
| Carry trend | 5% | Δ(sUSDh APY) over persisted 7d window | +2pp/7d → 100; −2pp/7d → 0 |
| Realized vol | 25% | 30d log-return stdev × √365 | ≤ 30% → 100; ≥ 80% → 0 |
| USDh peg | 10% | Bitflow Quote Engine USDh→USDCx round-trip | 0.999–1.001 → 100; ≤ 0.995 → 0 |

Missing components drop and remaining weights renormalize.

## Verified contracts (from canonical sources, not peer skills)

| Identifier | Source of verification |
|---|---|
| `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-v1-1.stake(uint, optional buff 64)` | Hiro `/v2/contracts/source` at block 3,567,258 — exact bytecode |
| `SPN5AK…HSG.usdh-token-v1` (decimals: 8, asset name: `usdh`) | Hiro Clarity source + Bitflow `/v1/tokens` registry |
| `SPN5AK…HSG.susdh-token-v1` (decimals: 8, minted by stake call) | Hiro Clarity source |
| `SPN5AK…HSG.staking-state-v1.get-staking-enabled`, `get-cooldown-window` (returns `u604800` = 7d) | Hiro Clarity source |
| `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx` (decimals: 6, asset name: `usdcx-token`) | Bitflow `/v1/tokens` registry |
| `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` (decimals: 8) | Bitflow `/v1/tokens` registry |
| `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-usdh-usdcx-v-1-bps-1` (`dlmm_8`) | Bitflow `/api/app/v1/pools/dlmm_8` empirical query |
| Zest V2 `market.borrow(ft, amount, receiver?, price-feeds?)` | Zest docs market trait — addresses resolved at runtime by `zest-borrow-asset-primitive` |

## Inline `stake` implementation — the USDh -> sUSDh leg

**Why inline (not a separate primitive):** No `hermetica-stake-primitive` exists in the registry. Per Issue #483 Rule 1, this skill is a single skill directory implementing its own functionality where no peer primitive exists. Bundling rules apply to multiple skill *directories* in one PR, not multiple capabilities within one skill.

**§6 verification:** every identifier in the inline call is sourced from `Hiro /v2/contracts/source` at block 3,567,258, not from peer skills.

**Tx construction (matches Issue #484 §8):**
- `contractAddress: SPN5AK…HSG`, `contractName: staking-v1-1`, `functionName: stake`
- `functionArgs: [uintCV(amountAtomic), noneCV()]` (affiliate = none for retail)
- `postConditionMode: PostConditionMode.Deny`
- `postConditions: [Pc.principal(wallet).willSendEq(amount).ft(<deployer>.usdh-token-v1, "usdh")]` (v7+ builder) or the v6 `makeStandardFungiblePostCondition(...)` triplet — the skill runtime-adapts to whichever `@stacks/transactions` major version is installed.
- Network: `STACKS_MAINNET` constant (v7+) or `new StacksMainnet()` (v6) — runtime-resolved.
- `broadcastTransaction` accepts both the v7+ object-arg shape `({ transaction, network })` and the legacy positional form; the skill tries the new shape first and falls back to positional.
- Broadcast and wait for inclusion

**On-chain effect** (verified Clarity, deployer's staking-v1-1 contract):
```clarity
(define-public (stake (amount uint) (affiliate (optional (buff 64))))
  ...
  (try! (contract-call? .usdh-token-v1 transfer amount contract-caller .staking-reserve-v1 none))
  (try! (contract-call? .susdh-token-v1 mint-for-protocol amount-susdh contract-caller))
  ...)
```
The wallet loses `amount` USDh and gains `amount-susdh = amount * usdh-base / ratio` sUSDh.

**Pre-checks** (read-only via Hiro, fail fast before broadcast):
- `staking-state-v1.get-staking-enabled` must return `true`
- Wallet's USDh balance must be ≥ amount
- A signer must be available (see "Signer" below)

## Signer (matches bff-skills primitives)

The inline stake leg's signer resolver mirrors the order used by `zest-asset-deposit-primitive`, `zest-borrow-asset-primitive`, and `bitflow-swap-aggregator` so a wallet that signs the supply / borrow / swap legs signs the stake leg too with no extra configuration. Each path is verified against `expectedWallet` (the `--wallet` flag) and rejected on mismatch:

1. **`AIBTC_SESSION_FILE`** — encrypted session written to `~/.aibtc/sessions/<wallet-id>.json` by `bun run wallet/wallet.ts unlock`. Decrypted with the matching `~/.aibtc/sessions/.session-key` (AES-256-GCM, 32-byte key). Active wallet id read from `AIBTC_WALLET_ID` env or `~/.aibtc/config.json#activeWalletId`.
2. **`STACKS_PRIVATE_KEY`** — raw hex private key in env. Derivation uses `@stacks/transactions.getAddressFromPrivateKey(key, "mainnet")` and rejects on address mismatch.
3. **`CLIENT_MNEMONIC`** — 12/24-word mnemonic in env. Derivation uses `@stacks/wallet-sdk.generateWallet({ secretKey, password: "" })` and rejects on address mismatch. Retained for bff-skills smoke-test environments.

If all three paths fail, the skill returns `SIGNER_UNAVAILABLE` with the per-path attempt list so the operator can see exactly which guard tripped.

**Operator setup (any one path is sufficient):**
- `bun run wallet/wallet.ts unlock --password <pw>` to write the AIBTC session, or
- `export STACKS_PRIVATE_KEY="<hex>"` to use a raw key, or
- `export CLIENT_MNEMONIC="word1 word2 ... word24"` to derive from a mnemonic.

The skill never logs or echoes the credential into JSON output.

## Safety notes

- **Write skill. Creates Zest debt and moves funds across three protocols.**
- **Hermetica unstake cooldown is 7 days.** Position cannot be unwound on short notice.
- Explicit `--confirm=ROTATE` for forward writes; `--confirm=AUTONOMOUS` for autonomous monitor start. No defaults.
- **Swap viability gate**: `--max-price-impact-bps` (default 50) refuses the swap leg if Quote Engine reports impact above threshold.
- Autonomous monitor: rate-limited to **one auto-action per 24h** per wallet; only broadcasts wind, **emits** `UNWIND_RECOMMENDED` signal (never broadcasts unwind).
- Single-borrow nonce safety inherited from `zest-borrow-asset-primitive`.
- BTC price uses median across 4 free sources; refuses if max-min dispersion > `--max-price-dispersion-pct`.
- Wallet reserve soft-warn: `RESERVE_BELOW_THRESHOLD` if external USDh+USDCx < `--emergency-reserve-pct` of projected debt. Does not refuse entry.
- Self-impact bounded sizing: `selfImpactBoundedSbtcSats` reports calculation result of operator-supplied `--pool-share-cap-pct`. Not a recommendation.
- Hermetica direct mint is out of scope (KYC-gated). Always swaps via Bitflow.

## Commands

### doctor
```bash
bun run windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh/windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts doctor --wallet <addr>
```

### status
```bash
bun run .../windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts status --wallet <addr>
```

### score
```bash
bun run .../windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts score --wallet <addr> --sbtc-amount-sats <sats> --target-ltv 0.40 --max-price-impact-bps 50
```

### plan
```bash
bun run .../windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts plan --wallet <addr> --sbtc-amount-sats <sats> --target-ltv 0.40
```

### run
```bash
# Registry environment (after `wallet unlock`):
bun run .../windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts run --wallet <addr> --sbtc-amount-sats <sats> --target-ltv 0.40 --min-score 55 --confirm=ROTATE

# bff-skills environment (smoke test):
CLIENT_MNEMONIC="..." bun run .../windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts run --wallet <addr> --sbtc-amount-sats <sats> --target-ltv 0.40 --min-score 55 --confirm=ROTATE
```

### resume
```bash
bun run .../windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts resume --wallet <addr> --confirm=ROTATE
```

### monitor (HITL — read-only)
```bash
bun run .../windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts monitor --wallet <addr> --poll-interval-seconds 3600 --max-iterations 24
```

### monitor (autonomous — broadcasts wind, emits unwind signals)
```bash
bun run .../windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts monitor --wallet <addr> --mode autonomous --sbtc-amount-sats <sats> --target-ltv 0.40 --poll-interval-seconds 3600 --min-score 55 --exit-score-below 35 --confirm=AUTONOMOUS
```

### cancel
```bash
bun run .../windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh.ts cancel --wallet <addr>
```

## State machine

```
idle
 └─run→ supply_confirmed → borrow_confirmed → swap_confirmed → complete (= sUSDh in wallet)
```

Unwind is the partner skill's responsibility.

## Output contract

All commands print exactly one JSON object to stdout:

```json
{ "status": "success | blocked | error", "action": "...", "data": {}, "error": null }
```

Error envelope `error.message` is reachable as the registry minimum `{ "error": "<message>" }` shape when unwrapped one level.

## Known constraints

- Mainnet only.
- sBTC → USDCx → USDh → sUSDh path only.
- Borrow asset is `USDCx` (post-migration canonical stablecoin).
- USDh swap routes through whichever Bitflow USDh venue the aggregator selects at quote time. At small sizes (~$1-50 USDCx) the aggregator typically picks the `BITFLOW_STABLE_XY_4` stableswap (`SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.stableswap-swap-helper-v-1-5`); at larger sizes it picks `dlmm_8`. The skill does not pin a route.
- Inline `stake` requires at least one of `AIBTC_SESSION_FILE` (an active unlocked AIBTC wallet session), `STACKS_PRIVATE_KEY` (raw hex), or `CLIENT_MNEMONIC` (12/24-word) — see "Signer" above. Without any, `run` / `resume` / autonomous broadcasts return `SIGNER_UNAVAILABLE` with the per-path attempt list. Read-only commands (doctor, status, score, plan, monitor HITL, cancel) work without a signer.
- Companion unwinder skill (separate PR) is required to close positions.
- No HODLMM LP-destination integration. The swap leg uses whichever Bitflow USDh venue the aggregator picks (`BITFLOW_STABLE_XY_4` stableswap or `dlmm_8` DLMM); the skill consumes the venue as a router, not as an LP destination.
- sUSDh APY estimate requires ≥ 24h of persisted exchange-rate samples.
- Autonomous mode requires the controller process to keep running.

## HODLMM integration declaration

**No.** The swap leg uses the Bitflow aggregator, which selects between `BITFLOW_STABLE_XY_4` (stableswap) and `dlmm_8` (HODLMM DLMM) based on quote. Even when it routes through `dlmm_8`, the skill does not LP into HODLMM as a destination — it consumes the venue as a router. Per the bonus criterion ("skills that directly integrate HODLMM"), the qualifying integration is LP/destination, not swap-venue routing.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @IamHarrie-Labs
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/604
