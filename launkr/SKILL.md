---
name: launkr
description: "Launch and trade restricted SIP-010 tokens on Launkr — a protected token launcher and XYK AMM on Stacks. Deploy a token, open a bonding or direct pool, and trade STX for tokens via the singleton contract. Works on both mainnet and testnet."
metadata:
  author: "rather-labs"
  author-agent: "Launkr by Rather Labs"
  user-invocable: "false"
  arguments: "launch | get-pool | quote-buy | quote-sell | swap-buy | swap-sell"
  entry: "launkr/launkr.ts"
  mcp-tools: "deploy_contract, call_contract, call_read_only_function"
  requires: "wallet"
  tags: "l2, defi, write, requires-funds"
---

# Launkr Skill

Launch and trade restricted SIP-010 tokens on [Launkr](https://launkr.io) — a protected token launcher and AMM on the Stacks blockchain, built by [Rather Labs](https://ratherlabs.com).

**What Launkr is:** A singleton XYK AMM that hosts N pools. Each pool trades STX against a *restricted* SIP-010 token — a token whose `transfer` function is locked so all trading must go through the authorized singleton. This guarantees fee capture on every swap.

**Two pool modes:**
- **Bonding** (`create-pool-bonding`) — Starts with virtual reserves. No STX seed required. Fees: 1%. Automatically graduates to direct mode when real STX collected crosses the graduation threshold.
- **Direct** (`create-pool-direct`) — Starts with a real STX seed (≥ 100 STX). Fees: 5%.

**Hash gate — critical:** The singleton verifies that each token's source is byte-identical to the on-chain template. Always fetch the template source verbatim from the Launkr API or from the Hiro API — never modify it.

---

## Protocol Info

Get contract IDs, floors, and fee schedule (call this first):

```
GET https://launkr.io/api/protocol?network=mainnet
GET https://launkr.io/api/protocol?network=testnet
```

**Mainnet contracts:**
- Singleton: `SP2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9Z367PM.lp-singleton-v6`
- Template: `SP2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9Z367PM.restricted-token-template-v6`
- Trait: `SP2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9Z367PM.restricted-ft-trait-v6`

**Testnet contracts:**
- Singleton: `ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.lp-singleton-v6`
- Template: `ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.restricted-token-template-v6`
- Trait: `ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.restricted-ft-trait-v6`

---

## How to Launch a Token

Launching requires two sequential transactions. **Do not send step 2 until step 1 confirms.**

### Step 1 — Get the launch intent

Call the Launkr API to receive the verbatim template source and the exact call intent:

```http
POST https://launkr.io/api/launch
Content-Type: application/json

{
  "network": "mainnet",
  "deployerAddress": "<your-stx-address>",
  "name": "My Agent Token",
  "symbol": "MAT",
  "supply": "1000000000000000",
  "mode": "bonding",
  "virtualStx": "500000000",
  "graduationThreshold": "2000000000",
  "feeReceiver": "<your-stx-address>"
}
```

Response:
```json
{
  "tokenPrincipal": "SP2....my-agent-token",
  "singletonId": "SP2....lp-singleton-v6",
  "steps": [
    {
      "step": 1,
      "kind": "contract-deploy",
      "contractName": "my-agent-token",
      "clarityVersion": 4,
      "clarityCode": "<verbatim template source — use byte-for-byte>"
    },
    {
      "step": 2,
      "kind": "contract-call",
      "contractId": "SP2....lp-singleton-v6",
      "functionName": "create-pool-bonding",
      "functionArgs": [...]
    }
  ]
}
```

### Step 2 — Deploy the token contract

Save `clarityCode` from the response to a temp file, then deploy it using `deploy_contract`:

```
deploy_contract(
  source="/tmp/my-agent-token.clar",
  name="my-agent-token"
)
```

Wait for the transaction to reach `success` status before continuing.
Check: `GET https://api.hiro.so/extended/v1/tx/{txid}`

### Step 3 — Create the pool

Use `call_contract` with the `functionName` and `functionArgs` from the API response.

**Bonding pool** (no STX pulled at creation — post-conditions array is empty):
```
call_contract(
  contract="SP2....lp-singleton-v6",
  function="create-pool-bonding",
  args=[
    {"type":"principal","value":"SP2....my-agent-token"},
    {"type":"string-ascii","value":"My Agent Token"},
    {"type":"string-ascii","value":"MAT"},
    {"type":"uint","value":"6"},
    {"type":"uint","value":"1000000000000000"},
    {"type":"(optional (string-utf8 256))","value":null},
    {"type":"uint","value":"500000000"},
    {"type":"uint","value":"2000000000"},
    {"type":"principal","value":"<fee-receiver-address>"}
  ],
  postConditionMode="deny",
  postConditions=[]
)
```

**Direct pool** (pulls `stxSeed` uSTX from tx-sender — include the post-condition):
```
call_contract(
  contract="SP2....lp-singleton-v6",
  function="create-pool-direct",
  args=[
    {"type":"principal","value":"SP2....my-agent-token"},
    {"type":"string-ascii","value":"My Agent Token"},
    {"type":"string-ascii","value":"MAT"},
    {"type":"uint","value":"6"},
    {"type":"uint","value":"1000000000000000"},
    {"type":"(optional (string-utf8 256))","value":null},
    {"type":"uint","value":"100000000"},
    {"type":"principal","value":"<fee-receiver-address>"}
  ],
  postConditionMode="deny",
  postConditions=[
    {"type":"stx","principal":"<your-stx-address>","conditionCode":"eq","amount":"100000000"}
  ]
)
```

---

## Subcommands

### launch

Launch a new token on Launkr (two sequential transactions, automatic confirmation wait).

```
bun run launkr/launkr.ts launch \
  --name "My Agent Token" \
  --symbol MAT \
  --supply 1000000000000000 \
  --mode bonding \
  --virtual-stx 500000000 \
  --graduation-threshold 2000000000 \
  --fee-receiver <stx-address> \
  [--uri <metadata-uri>]```

For direct mode, replace `--virtual-stx` and `--graduation-threshold` with `--stx-seed <uSTX>` (min `100000000`).

Output:
```json
{
  "success": true,
  "tokenPrincipal": "SP2....my-agent-token",
  "deployTxid": "abc123...",
  "poolTxid": "def456...",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/def456...?chain=mainnet",
  "launkrUrl": "https://launkr.io/token/SP2....my-agent-token"
}
```

### get-pool

Get pool state for a token. No wallet required.

```
bun run launkr/launkr.ts get-pool \
  --token <tokenPrincipal>```

Output:
```json
{
  "token": "SP2....my-token",
  "mode": "bonding",
  "stxReserve": "0",
  "tokenReserve": "1000000000000000",
  "virtualStx": "500000000",
  "graduationThreshold": "2000000000",
  "bondedStxCollected": "12300000",
  "active": true,
  "feeReceiver": "SP2....",
  "network": "mainnet"
}
```

Pool mode values: `direct` (u0), `bonding` (u1), `graduated` (u2).

### quote-buy

Simulate a buy — returns tokens out net of fees. No wallet required.

```
bun run launkr/launkr.ts quote-buy \
  --token <tokenPrincipal> \
  --stx-in <uSTX>```

Output:
```json
{
  "token": "SP2....my-token",
  "stxIn": "10000000",
  "tokensOut": "1952380952",
  "network": "mainnet"
}
```

### quote-sell

Simulate a sell — returns STX out net of fees. No wallet required.

```
bun run launkr/launkr.ts quote-sell \
  --token <tokenPrincipal> \
  --tokens-in <atomic-units>```

Output:
```json
{
  "token": "SP2....my-token",
  "tokensIn": "1000000000",
  "stxOut": "4950000",
  "network": "mainnet"
}
```

### swap-buy

Buy tokens with STX. Requires an unlocked wallet.

```
bun run launkr/launkr.ts swap-buy \
  --token <tokenPrincipal> \
  --stx-in <uSTX> \
  --min-tokens-out <atomic-units> \
  [--deadline <block-height>] \
  [--recipient <stx-address>]```

Options:
- `--token` (required) — Full token principal (e.g. `SP2....my-token`)
- `--stx-in` (required) — uSTX to spend
- `--min-tokens-out` (required) — Slippage guard: minimum tokens to receive (run `quote-buy` first, apply 1–2% tolerance)
- `--deadline` (optional) — Max Stacks block height (default: `4294967295`, no deadline)
- `--recipient` (optional) — Address to receive tokens (default: wallet address)

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "stxIn": "10000000",
  "minTokensOut": "1900000000",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet"
}
```

### swap-sell

Sell tokens for STX. Requires an unlocked wallet.

```
bun run launkr/launkr.ts swap-sell \
  --token <tokenPrincipal> \
  --tokens-in <atomic-units> \
  --min-stx-out <uSTX> \
  [--deadline <block-height>] \
  [--recipient <stx-address>]```

Options:
- `--token` (required) — Full token principal
- `--tokens-in` (required) — Atomic token units to sell
- `--min-stx-out` (required) — Slippage guard: minimum uSTX to receive (run `quote-sell` first)
- `--deadline` (optional) — Max Stacks block height
- `--recipient` (optional) — Address to receive STX (default: wallet address)

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "tokensIn": "1000000000",
  "minStxOut": "4800000",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet"
}
```

---

## Arguments

| Subcommand | Option | Required | Description |
|------------|--------|----------|-------------|
| `launch` | `--name` | yes | Token display name (max 32 chars) |
| `launch` | `--symbol` | yes | Token symbol (max 32 chars) |
| `launch` | `--supply` | yes | Total supply in atomic units (min `100000000000000` = 100M @ 6 dec) |
| `launch` | `--mode` | yes | `bonding` or `direct` |
| `launch` | `--fee-receiver` | yes | STX address that receives 90% of swap fees |
| `launch` | `--virtual-stx` | bonding only | Virtual STX reserve in uSTX (min `500000000`) |
| `launch` | `--graduation-threshold` | bonding only | Real STX to collect before graduating (min `2000000000`, max 10× virtual-stx and `10000000000000`) |
| `launch` | `--stx-seed` | direct only | Real STX to seed the pool in uSTX (min `100000000`) |
| `launch` | `--uri` | no | Optional token metadata URI |
| `launch` | `--fee` | no | Fee preset (`low`\|`medium`\|`high`) or explicit micro-STX amount (default: auto-estimate) |
| `get-pool` | `--token` | yes | Full token principal (`ADDRESS.contract-name`) |
| `quote-buy` | `--token` | yes | Full token principal |
| `quote-buy` | `--stx-in` | yes | uSTX to spend |
| `quote-sell` | `--token` | yes | Full token principal |
| `quote-sell` | `--tokens-in` | yes | Atomic token units to sell |
| `swap-buy` | `--token` | yes | Full token principal |
| `swap-buy` | `--stx-in` | yes | uSTX to spend |
| `swap-buy` | `--min-tokens-out` | yes | Slippage guard (use `quote-buy` first) |
| `swap-buy` | `--deadline` | no | Max block height (default: no deadline) |
| `swap-buy` | `--recipient` | no | Recipient address (default: wallet address) |
| `swap-buy` | `--fee` | no | Fee preset or micro-STX amount (default: auto-estimate) |
| `swap-sell` | `--token` | yes | Full token principal |
| `swap-sell` | `--tokens-in` | yes | Atomic token units to sell |
| `swap-sell` | `--min-stx-out` | yes | Slippage guard (use `quote-sell` first) |
| `swap-sell` | `--deadline` | no | Max block height |
| `swap-sell` | `--recipient` | no | Recipient address |
| `swap-sell` | `--fee` | no | Fee preset or micro-STX amount (default: auto-estimate) |

**Network:** All subcommands act on the network selected by the `NETWORK` environment variable (default `testnet`) — the same source the wallet and every other skill use. There is no `--network` flag. Prefix a command with `NETWORK=mainnet` to target mainnet, e.g. `NETWORK=mainnet bun run launkr/launkr.ts get-pool --token <principal>`.

---

## Protocol Floors

The singleton enforces these on-chain — the API validates them before returning an intent, but apply them when calling the contract directly.

| Parameter | Minimum | Maximum |
|-----------|---------|---------|
| supply (atomic units) | `100000000000000` | `1000000000000000000000` |
| decimals | — | `18` |
| stxSeed (direct mode) | `100000000` (100 STX) | — |
| virtualStx (bonding mode) | `500000000` (500 STX) | — |
| graduationThreshold | `2000000000` (2000 STX) | `10000000000000` (10M STX) |
| graduationThreshold | — | 10× virtualStx |

---

## Error Codes

| Code | Error | Cause |
|------|-------|-------|
| u200 | `ERR_POOL_EXISTS` | A pool already exists for this token |
| u201 | `ERR_TOKEN_NOT_OURS` | Token source doesn't match the approved hash |
| u209 | `ERR_VIRTUAL_RATIO_TOO_LOW` | virtualStx too low relative to supply |
| u217 | `ERR_NOT_GRADUATED` | `swap-and-burn` called on a bonding pool |
| u220 | `ERR_RATIO_TOO_HIGH` | graduationThreshold > 10× virtualStx |
| u221 | `ERR_GRADUATION_TOO_HIGH` | graduationThreshold > 10M STX |
| u224 | `ERR_DEGENERATE_CURVE` | < 50% of supply would be released at graduation |

---

## Notes

- **Hash gate:** Every token deployed must be byte-identical to `restricted-token-template-v6`. Use `POST https://launkr.io/api/launch` to get the verbatim source. Never edit the source code — any change causes `ERR_TOKEN_NOT_OURS u201` on `create-pool`.
- **Confirm before step 2:** Wait for the deploy tx to reach `success` on-chain before calling `create-pool-*`. The singleton reads the deployed contract's source at pool creation time.
- **No seed for bonding:** `create-pool-bonding` pulls no STX at creation. The pool starts with virtual reserves only. The post-conditions array is empty.
- **Quote before swap:** Always call `quote-buy` or `quote-sell` first. Apply a 1–2% slippage tolerance to derive `min-tokens-out` / `min-stx-out`.
- **Post-conditions:** Both swaps run in `Deny` mode. `swap-buy` scopes an STX post-condition equal to `--stx-in`. `swap-sell` scopes a fungible post-condition equal to `--tokens-in` on the token you sell — its SIP-010 asset name is always `strategy-token` (every token is a byte-identical copy of `restricted-token-template-v6`), so a sell can never move more of your tokens than the amount you passed. The STX the singleton pays back is authorized by the contract's own Clarity-4 `as-contract?` allowance.
- **Graduated pools:** Once a bonding pool crosses its `graduationThreshold`, it permanently becomes a direct (5% fee) pool. `swap-and-burn` then becomes available — fee-free, permissionless deflation.
- **Pool visibility:** All pools — including agent-launched ones — appear on `launkr.io` automatically. The frontend indexes pools via Hiro API events.
- **Testnet faucet:** https://explorer.hiro.so/sandbox/faucet?chain=testnet
- **Full protocol reference:** https://launkr.io/api/protocol
