---
name: sbtc
description: sBTC token operations on Stacks L2 — check balances, transfer sBTC, get deposit info, check peg statistics, deposit BTC to receive sBTC, and track deposit status. Transfer and deposit operations require an unlocked wallet.
user-invocable: false
arguments: get-balance | transfer | get-deposit-info | get-peg-info | deposit | deposit-status
category: assets
requires: [wallet]
tags: [requires-wallet, has-read-ops, has-write-ops, requires-funds]
entry-point: sbtc.ts
---

# sBTC Skill

Provides sBTC (wrapped Bitcoin on Stacks L2) operations. sBTC uses 8 decimals — the same as Bitcoin. Transfer and deposit operations require an unlocked wallet (use `bun run wallet/wallet.ts unlock` first). Balance and info queries work without a wallet.

## Usage

```
bun run sbtc/sbtc.ts <subcommand> [options]
```

## Subcommands

### get-balance

Get the sBTC balance for a Stacks address.

```
bun run sbtc/sbtc.ts get-balance [--address <addr>]
```

Options:
- `--address` (optional) — Stacks address to check (uses active wallet if omitted)

Output:
```json
{
  "address": "SP2...",
  "network": "mainnet",
  "balance": {
    "sats": "100000",
    "btc": "0.001 sBTC"
  }
}
```

### transfer

Transfer sBTC to a recipient. Requires an unlocked wallet.

sBTC uses 8 decimals. Specify `--amount` in satoshis (1 sBTC = 100,000,000 satoshis).

```
bun run sbtc/sbtc.ts transfer --recipient <addr> --amount <sats> [--memo <text>] [--fee low|medium|high|<microStx>] [--sponsored]
```

Options:
- `--recipient` (required) — Stacks address to send to
- `--amount` (required) — Amount in satoshis (e.g., "100000" for 0.001 sBTC)
- `--memo` (optional) — Memo message to include
- `--fee` (optional) — Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted
- `--sponsored` (flag) — Use fee sponsorship if available

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "from": "SP2...",
  "recipient": "SP3...",
  "amount": "0 sBTC",
  "amountSats": "100000",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet"
}
```

### get-deposit-info

Get information about how to deposit BTC to receive sBTC. If a wallet with Taproot keys is unlocked, returns a personalized deposit address. Otherwise returns general instructions.

```
bun run sbtc/sbtc.ts get-deposit-info
```

Output (with unlocked wallet):
```json
{
  "network": "mainnet",
  "depositAddress": "bc1p...",
  "maxSignerFee": "80000 satoshis",
  "reclaimLockTime": "950 blocks",
  "stacksAddress": "SP2...",
  "instructions": [...]
}
```

Output (without wallet):
```json
{
  "network": "mainnet",
  "depositAddress": "bc1p...",
  "minDeposit": "...",
  "maxDeposit": "...",
  "instructions": [...]
}
```

### get-peg-info

Get sBTC peg information including total supply and peg ratio.

```
bun run sbtc/sbtc.ts get-peg-info
```

Output:
```json
{
  "network": "mainnet",
  "totalSupply": {
    "sats": "1000000000",
    "btc": "10 sBTC"
  },
  "pegRatio": "1.000000"
}
```

### deposit

Deposit BTC to receive sBTC on Stacks L2. Builds, signs, and broadcasts a Bitcoin transaction to the sBTC deposit address. After Bitcoin confirmation, sBTC tokens are minted to your Stacks address. Requires an unlocked wallet with Bitcoin and Taproot keys.

By default only uses cardinal UTXOs (safe to spend — no inscriptions).

```
bun run sbtc/sbtc.ts deposit --amount <sats> [--fee-rate fast|medium|slow|<number>] [--max-signer-fee <sats>] [--reclaim-lock-time <blocks>] [--include-ordinals]
```

Options:
- `--amount` (required) — Amount to deposit in satoshis (1 BTC = 100,000,000 satoshis)
- `--fee-rate` (optional) — `fast` (~10 min), `medium` (~30 min), `slow` (~1 hr), or number in sat/vB (default: `medium`)
- `--max-signer-fee` (optional) — Max fee the sBTC system can charge in satoshis (default: 80000)
- `--reclaim-lock-time` (optional) — Blocks until reclaim becomes available if deposit fails (default: 950)
- `--include-ordinals` (flag) — Include ordinal UTXOs (WARNING: may destroy valuable inscriptions!)

Output:
```json
{
  "success": true,
  "txid": "btcTxid123...",
  "explorerUrl": "https://mempool.space/tx/btcTxid123...",
  "deposit": {
    "amount": "0.001 BTC",
    "amountSats": 100000,
    "recipient": "SP2...",
    "bitcoinAddress": "bc1q...",
    "taprootAddress": "bc1p...",
    "maxSignerFee": "80000 sats",
    "reclaimLockTime": "950 blocks",
    "feeRate": "5 sat/vB"
  },
  "network": "mainnet",
  "note": "sBTC tokens will be minted to your Stacks address after Bitcoin transaction confirms."
}
```

### deposit-status

Check the status of an sBTC deposit transaction via the Emily API.

```
bun run sbtc/sbtc.ts deposit-status --txid <btcTxid> [--vout <index>]
```

Options:
- `--txid` (required) — Bitcoin transaction ID of the deposit
- `--vout` (optional) — Output index of the deposit (default: 0)

Output:
```json
{
  "txid": "btcTxid123...",
  "vout": 0,
  "status": "pending",
  "explorerUrl": "https://mempool.space/tx/btcTxid123...",
  "network": "mainnet"
}
```

## Notes

- Balance and info queries use the Hiro API (no authentication required)
- Transfer and deposit operations require an unlocked wallet
- sBTC uses 8 decimal places — same as Bitcoin satoshis
- The `deposit` command uses Bitcoin L1 — ensure you have BTC in your wallet's Bitcoin address
- After depositing, sBTC tokens appear in your Stacks address after Bitcoin confirmation
