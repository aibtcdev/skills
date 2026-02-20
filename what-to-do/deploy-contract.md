---
title: Deploy Contract
description: Deploy a Clarity smart contract to Stacks, monitor the transaction, and verify the contract is live.
skills: [wallet, stx, query]
estimated-steps: 5
order: 7
---

# Deploy Contract

Deploying a Clarity smart contract to Stacks requires an unlocked wallet with sufficient STX for the deployment fee. The contract name must be unique within the deploying address's namespace. After broadcasting, the transaction is pending until included in a Stacks block (typically within a few minutes).

Once confirmed, the contract is accessible at `<deployer-address>.<contract-name>` and can be inspected via the `query` skill.

## Prerequisites

- [ ] Wallet unlocked with STX balance (minimum ~0.05 STX for small contracts; larger contracts cost more)
- [ ] Clarity contract source code ready
- [ ] Contract name chosen (lowercase, hyphens allowed, must be unique for your address)

## Steps

### 1. Unlock Wallet

```bash
bun run wallet/wallet.ts unlock --password <your-password>
```

Expected output: `success: true`, `Stacks (L2).Address: SP...`.

### 2. Check STX Balance and Fee Estimates

Confirm balance and review fee tiers before deploying.

```bash
bun run stx/stx.ts get-balance
bun run query/query.ts get-stx-fees
```

Expected output from `get-balance`: `balance.stx` > 0.05 STX.
Expected output from `get-stx-fees`: `byTransactionType.smartContract.medium` showing estimated micro-STX.

### 3. Deploy the Contract

Pass the complete Clarity source code via `--code-body`. Use single quotes to avoid shell interpolation issues with special characters.

```bash
bun run stx/stx.ts deploy-contract \
  --contract-name my-contract \
  --code-body '(define-public (hello) (ok "hello world"))' \
  --fee medium
```

Expected output: `success: true`, `txid` (0x-prefixed), `contractId` (`SP....my-contract`), `explorerUrl`.

Save the `txid` and `contractId` for subsequent steps.

> Note: For multi-line Clarity source, read from a file using shell substitution: `--code-body "$(cat ./my-contract.clar)"`.

### 4. Monitor Transaction Status

Poll until the transaction is confirmed.

```bash
bun run stx/stx.ts get-transaction-status --txid 0xYOUR_TXID
```

Expected output: `status: "success"`, `block_height` populated.

> Note: Status may show `pending` for 1-10 minutes. Re-run until `success`. A `failed` status means the contract was rejected — check the Clarity syntax.

### 5. Verify the Contract is Live

Confirm the contract is accessible on-chain and inspect its ABI.

```bash
bun run query/query.ts get-contract-info \
  --contract-id SP....my-contract
```

Expected output: `contractId`, `blockHeight`, `functions` array listing all public and read-only functions.

To call a read-only function on the deployed contract:

```bash
bun run query/query.ts call-read-only \
  --contract-id SP....my-contract \
  --function-name hello
```

Expected output: `okay: true`, `result` containing the Clarity return value.

## Verification

At the end of this workflow, verify:
- [ ] Deployment transaction returned `success: true` with a `contractId`
- [ ] Transaction status reached `"success"`
- [ ] `get-contract-info` returns the expected function list

## Related Skills

| Skill | Used For |
|-------|---------|
| `stx` | Deploying the contract and checking transaction status |
| `query` | Fee estimation, contract ABI inspection, and read-only calls |
| `wallet` | Wallet unlock for contract deployment signing |

## See Also

- [Register ERC-8004 Identity](./register-erc8004-identity.md)
- [Sign and Verify](./sign-and-verify.md)
