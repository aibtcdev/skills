---
name: contract
description: "Clarity smart contract deployment and interaction — deploy contracts from source files, call public functions with post conditions, and call read-only functions."
metadata:
  author: "tfibtcagent"
  user-invocable: "false"
  arguments: "deploy | call | read"
  entry: "contract/contract.ts"
  mcp-tools: "deploy_contract, call_contract, call_read_only_function"
  requires: "wallet"
  tags: "l2, write, requires-funds"
---

# Contract Skill

Provides Clarity smart contract deployment and interaction on the Stacks blockchain. Deploy contracts from `.clar` source files, call public functions (with optional post conditions), and call read-only functions to query on-chain state.

- **read** — Read-only, no wallet required.
- **deploy** and **call** — Write operations that broadcast transactions; require an unlocked wallet.

## Usage

```
bun run contract/contract.ts <subcommand> [options]
```

## Subcommands

### deploy

Deploy a Clarity smart contract to the Stacks blockchain. Reads the contract source from a `.clar` file and broadcasts a `smart_contract` transaction.

```
bun run contract/contract.ts deploy \
  --source <path-to-file.clar> \
  --name <contract-name> \
  [--fee <fee>]
```

Options:
- `--source` (required) — Path to the `.clar` source file to deploy
- `--name` (required) — Contract name (lowercase, hyphens allowed, max 128 chars)
- `--fee` (optional) — Fee preset (`low|medium|high`) or micro-STX amount; auto-estimated if omitted

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "contractId": "SP2...deployer.my-contract",
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet"
}
```

### call

Call a public function on a deployed Stacks smart contract. Signs and broadcasts a `contract_call` transaction.

```
bun run contract/contract.ts call \
  --contract <contractId> \
  --function <functionName> \
  --args <json-array> \
  [--post-condition-mode <deny|allow>] \
  [--post-conditions <json-array>] \
  [--fee <fee>]
```

Options:
- `--contract` (required) — Full contract ID in `ADDRESS.contract-name` format
- `--function` (required) — Public function name to call
- `--args` (optional) — Function arguments as a JSON array (default: `[]`). Typed objects use `{"type":"uint","value":100}` format.
- `--post-condition-mode` (optional) — `deny` (default) blocks unexpected token transfers; `allow` permits any
- `--post-conditions` (optional) — Post conditions as a JSON array (see Notes for format)
- `--fee` (optional) — Fee preset (`low|medium|high`) or micro-STX amount; auto-estimated if omitted

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "contract": "SP2...deployer.my-contract",
  "function": "set-value",
  "args": [42],
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123...?chain=mainnet"
}
```

### read

Call a read-only function on a deployed Stacks smart contract. Does not broadcast a transaction; no wallet required.

```
bun run contract/contract.ts read \
  --contract <contractId> \
  --function <functionName> \
  [--args <json-array>] \
  [--sender <address>]
```

Options:
- `--contract` (required) — Full contract ID in `ADDRESS.contract-name` format
- `--function` (required) — Read-only function name to call
- `--args` (optional) — Function arguments as a JSON array (default: `[]`)
- `--sender` (optional) — Stacks address to use as the read-only call sender (uses active wallet address if omitted)

Output:
```json
{
  "contract": "SP2...deployer.my-contract",
  "function": "get-value",
  "okay": true,
  "result": "(ok u42)",
  "network": "mainnet"
}
```

## Arguments

| Subcommand | Option | Required | Description |
|------------|--------|----------|-------------|
| `deploy` | `--source` | yes | Path to `.clar` source file |
| `deploy` | `--name` | yes | Contract name |
| `deploy` | `--fee` | no | Fee preset or micro-STX amount |
| `call` | `--contract` | yes | Full contract ID (`ADDRESS.name`) |
| `call` | `--function` | yes | Public function name |
| `call` | `--args` | no | JSON array of function arguments |
| `call` | `--post-condition-mode` | no | `deny` (default) or `allow` |
| `call` | `--post-conditions` | no | JSON array of post condition objects |
| `call` | `--fee` | no | Fee preset or micro-STX amount |
| `read` | `--contract` | yes | Full contract ID (`ADDRESS.name`) |
| `read` | `--function` | yes | Read-only function name |
| `read` | `--args` | no | JSON array of function arguments |
| `read` | `--sender` | no | Sender address for the read-only call |

## Notes

- Contract names must be unique per deployer address. Deploying a contract that already exists will fail.
- Deployment is irreversible — the contract lives on-chain permanently once confirmed.
- Pre-simulate contract calls on [stxer.xyz](https://stxer.xyz) before deploying or calling to catch Clarity errors and estimate fees without spending STX.
- Post condition format: `{"type":"stx","principal":"SP2...","conditionCode":"eq","amount":"1000000"}` for STX; `{"type":"ft","principal":"SP2...","asset":"SP2....my-token","assetName":"my-token","conditionCode":"eq","amount":"100"}` for fungible tokens; `{"type":"nft","principal":"SP2...","asset":"SP2....my-nft","assetName":"my-nft","tokenId":1}` for NFTs — NFT conditions are binary (send/not-send), so `conditionCode` is not applicable; use `"notSend":true` to assert the NFT must NOT leave the principal.
- `--post-condition-mode allow` skips post condition checks entirely — use only when you fully trust the contract logic and have verified the source code.
- Wallet operations require an unlocked wallet (use `bun run wallet/wallet.ts unlock --password <password>` first).
