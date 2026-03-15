---
name: souldinals-agent
skill: souldinals
description: Souldinals collection management — inscribe soul.md as a child inscription under a genesis parent, list and load soul inscriptions, display soul traits.
---

# Souldinals Agent

This agent manages Souldinals — soul.md files inscribed as child ordinals on Bitcoin L1. Soul inscriptions follow the same two-step commit/reveal pattern as the ordinals skill. All write operations require an unlocked wallet with BTC on the SegWit address.

## Prerequisites

- Wallet must be unlocked for all subcommands that access key material — use `bun run wallet/wallet.ts unlock --password <password>` first
- `inscribe-soul` and `reveal-soul` require BTC balance on the SegWit (bc1q/tb1q) address
- Soul inscriptions are received at the Taproot (bc1p/tb1p) address
- A genesis parent inscription ID is required for `inscribe-soul` — this is the collection's root
- `HIRO_API_KEY` env var is optional but recommended for higher rate limits on `list-souls` and `load-soul`

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Inscribe your soul.md on Bitcoin under a parent collection | `inscribe-soul` — step 1, broadcasts commit tx; save `commitTxid`, `revealAmount`, `contentBase64` |
| Finalize soul inscription after commit confirms | `reveal-soul` — step 2, broadcasts reveal tx |
| List all soul inscriptions held by the wallet | `list-souls` — queries Hiro Ordinals API, no funds needed |
| Load the oldest soul inscription's full content | `load-soul` — fetches content via Hiro Ordinals API |
| Parse and display traits from a specific soul inscription | `display-soul --inscription-id <id>` |

## Safety Checks

- Run `bun run ordinals/ordinals.ts estimate-fee` before `inscribe-soul` to confirm sufficient BTC balance
- After `inscribe-soul`, **wait for the commit transaction to confirm** before running `reveal-soul` — check mempool.space using the `commitExplorerUrl` from the response
- The `contentBase64` passed to `reveal-soul` must exactly match the output from `inscribe-soul` — any mismatch produces an incorrect reveal script and a failed inscription
- Do not spend the commit UTXO (at `revealAddress`) with any other transaction before `reveal-soul`
- Always verify the `--parent-inscription-id` is a valid genesis inscription owned by the collection before inscribing

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Wallet not unlocked. Use wallet/wallet.ts unlock first." | Write operation without unlocked wallet | Run `bun run wallet/wallet.ts unlock --password <password>` |
| "Wallet doesn't have Bitcoin addresses. Use a managed wallet." | Session missing BTC address fields | Unlock a managed wallet (not env-var-based) |
| "Bitcoin keys not available. Wallet may not be unlocked." | Keys missing from session | Unlock wallet again |
| "No UTXOs available for address .... Send some BTC first." | No confirmed BTC to fund commit | Send BTC to the wallet's SegWit address |
| "Soul file not found: <path>" | soul.md missing at specified path | Verify `--soul-file` path or ensure `./SOUL.md` exists |
| "Soul file is empty" | soul.md exists but has no content | Write content to the soul file before inscribing |
| "--commit-txid must be exactly 64 hex characters" | Malformed txid | Copy `commitTxid` exactly from `inscribe-soul` response |
| "--reveal-amount must be a positive integer" | Invalid reveal amount | Copy `revealAmount` exactly from `inscribe-soul` response |
| "No soul inscriptions found" | Wallet has no text/markdown inscriptions | Inscribe a soul first with `inscribe-soul` |
| "Failed to fetch inscription content" | Hiro API error or invalid inscription ID | Verify inscription ID format and network connectivity |

## Output Handling

- `inscribe-soul`: **save** `commitTxid`, `revealAmount`, and `contentBase64` — all three are required for `reveal-soul`; use `commitExplorerUrl` to monitor confirmation; `parentInscriptionId` confirms the child binding
- `reveal-soul`: the `inscriptionId` is `{revealTxid}i0`; save this as the soul's permanent on-chain identifier
- `list-souls`: `souls` array is sorted oldest-first; `souls[0]` is the genesis soul if multiple exist
- `load-soul`: `content` field contains the full soul.md text; use to reload agent identity context
- `display-soul`: `traits.name` and `traits.description` are parsed from first-level headings; `traits.sections` contains all named sections; `traits.values` and `traits.focusAreas` are parsed from list items under matching section headers

## Example Invocations

```bash
# Step 1: Inscribe soul (commit)
bun run souldinals/souldinals.ts inscribe-soul \
  --parent-inscription-id <genesisId> \
  --soul-file ./SOUL.md

# Step 2: Reveal (after commit confirms)
bun run souldinals/souldinals.ts reveal-soul \
  --commit-txid <commitTxid> \
  --reveal-amount <revealAmount> \
  --content-base64 <contentBase64>

# List all souls in wallet
bun run souldinals/souldinals.ts list-souls

# Load and display oldest soul content
bun run souldinals/souldinals.ts load-soul

# Display traits from a specific soul
bun run souldinals/souldinals.ts display-soul --inscription-id <inscriptionId>
```
