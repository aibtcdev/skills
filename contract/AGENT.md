---
name: contract-agent
skill: contract
description: Clarity smart contract deployment and interaction — deploy contracts from source files, call public functions with post conditions, and call read-only functions.
---

# Contract Agent

This agent handles Clarity smart contract operations on the Stacks blockchain. Read operations (`read`) work without a wallet. Write operations (`deploy`, `call`) sign and broadcast transactions — they require an unlocked wallet, sufficient STX for gas, and careful pre-flight checks.

## Prerequisites

- Wallet unlocked via `bun run wallet/wallet.ts unlock` (for `deploy` and `call` only)
- Sufficient STX balance for transaction fees (check with `bun run stx/stx.ts get-balance`)
- For `deploy`: a valid `.clar` source file at the specified path
- For `call`: the target contract must already be deployed; verify with `bun run query/query.ts contract-info --contract <contractId>`

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Query contract state, call view functions | `read` — no wallet, no fee, returns Clarity value |
| Deploy a new Clarity contract | `deploy` — irreversible; pre-simulate first |
| Call a public function on an existing contract | `call` — costs STX gas; set post conditions |

## Safety Checks

- **Before `deploy`**: pre-simulate the contract on [stxer.xyz](https://stxer.xyz) to catch Clarity errors before spending gas. Deployment is permanent and irreversible.
- **Before `deploy`**: confirm the contract name is not already deployed at your address (each `ADDRESS.contract-name` is unique on-chain).
- **Before `call`**: run `read` on any relevant view functions to understand current contract state before writing.
- **Before `call`**: set `--post-condition-mode deny` (the default) and define explicit `--post-conditions` whenever the function transfers tokens. Never use `allow` mode unless you have verified the full contract source code and trust it completely.
- **Before `call`**: estimate fees by using `--fee low` on testnet first, or use stxer.xyz to simulate the call.

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "No wallet available" | Wallet not unlocked | Run `bun run wallet/wallet.ts unlock --password <password>` |
| "Broadcast failed: ContractAlreadyExists" | Contract name already deployed at this address | Choose a different `--name` |
| "Broadcast failed: BadFunctionName" | Function does not exist on the contract | Check the ABI with `bun run query/query.ts contract-info` |
| "--source file not found" | `.clar` file path is wrong or missing | Verify the file path exists before deploying |
| "--contract must be in ADDRESS.name format" | Contract ID malformed | Use full `SP2....contract-name` format |
| "okay: false" on `read` | Contract rejected the read-only call | Check `result` field for the Clarity error; verify function name and args |

## Output Handling

- `deploy`: use `contractId` to verify the deployment in explorer; pass to future `call` and `read` invocations
- `call`: `txid` and `explorerUrl` confirm the broadcast; poll `bun run stx/stx.ts get-transaction-status --txid <txid>` until `status: "success"`
- `read`: `okay: true` means the call succeeded; `result` is the raw Clarity value as a string (e.g., `(ok u42)`, `(some "hello")`)

## Example Invocations

```bash
# Deploy a contract from source file
bun run contract/contract.ts deploy \
  --source ./my-contract.clar \
  --name my-contract

# Call a public function (no token transfers, default deny mode)
bun run contract/contract.ts call \
  --contract SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.my-contract \
  --function set-value \
  --args '[42]'

# Call a function that sends STX (with post condition)
bun run contract/contract.ts call \
  --contract SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.my-contract \
  --function buy \
  --args '[100]' \
  --post-conditions '[{"type":"stx","principal":"SP1092FF21MZXE9D7SZ7F86WA3Q58BY9WCZ0T0DF7","conditionCode":"eq","amount":"1000000"}]'

# Call a read-only function
bun run contract/contract.ts read \
  --contract SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.my-contract \
  --function get-value
```
