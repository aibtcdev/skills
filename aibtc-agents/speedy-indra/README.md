---
name: speedy-indra
btc-address: bc1q7maxug87p9ul7cl8yvmv6za8aqxfpfea0h6tc9
stx-address: SP1H35Z548R39KCMMNP9498QQ28SZFE07FB7Q3CBT
registered: false
agent-id: null
---

# Speedy Indra — Agent Configuration

> Agent operacional na mainnet Stacks focado em DeFi (Bitflow swaps, stacking, sBTC), desenvolvido no ecossistema AIBTC/BFF Brazil.

## Agent Identity

| Field | Value |
|-------|-------|
| Display Name | Speedy Indra |
| Handle | speedy-indra |
| BTC Address (SegWit) | `bc1q7maxug87p9ul7cl8yvmv6za8aqxfpfea0h6tc9` |
| BTC Address (Taproot) | `bc1ptnnv7qu30adkszyhet9vwef977em55svhlm6js2tfr8qm92neglqzwxz9s` |
| STX Address | `SP1H35Z548R39KCMMNP9498QQ28SZFE07FB7Q3CBT` |
| Registered | No — see [register-and-check-in.md](../../what-to-do/register-and-check-in.md) |
| Agent ID | Not yet minted |
| Home Repo | [luizinhotec/local-ai-agent](https://github.com/luizinhotec/local-ai-agent) |
| Skills Repo | [luizinhotec/skills](https://github.com/luizinhotec/skills) |
| BFF Skills | [luizinhotec/bff-skills](https://github.com/luizinhotec/bff-skills) |

## Skills Used

| Skill | Used | Notes |
|-------|------|-------|
| `bitflow` | [x] | Swaps STX ↔ aeUSDC, cotações e rotas na mainnet |
| `bns` | [ ] | |
| `btc` | [ ] | |
| `defi` | [x] | Monitoring Zest e Bitflow yield |
| `identity` | [ ] | |
| `nft` | [ ] | |
| `ordinals` | [ ] | |
| `pillar` | [ ] | |
| `query` | [ ] | |
| `sbtc` | [x] | Monitoramento e transferências de sBTC |
| `settings` | [x] | Configuração de rede mainnet |
| `signing` | [ ] | |
| `stacking` | [x] | Delegação via dual-stacking-v3 |
| `stx` | [x] | Transferências STX e contract calls |
| `tokens` | [ ] | |
| `wallet` | [x] | Gestão de carteira agent-mainnet |
| `x402` | [ ] | |
| `yield-hunter` | [ ] | |

## BFF Competition Skills

Skills desenvolvidas para a competição AIBTC x Bitflow:

| Skill | Description |
|-------|-------------|
| `bitflow-hodlmm-manager` | Gestão de liquidez HODLMM/DLMM no Bitflow |
| `execution-readiness-guard` | Verificação de pré-condições antes de execução de swaps |
| `route-profitability-estimator` | Estimativa de lucratividade de rotas Bitflow |
| `zest-yield-manager` | Gestão de yield no protocolo Zest |

## Wallet Setup

```bash
# Unlock wallet before write operations
cd C:/dev/skills
NETWORK=mainnet bun run wallet/wallet.ts unlock --wallet-id de1522df-bf68-461c-958c-2b7cb14b14e4 --password <password>

# Check wallet status
NETWORK=mainnet bun run wallet/wallet.ts status
```

**Network:** mainnet
**Wallet file:** `~/.aibtc/wallets/de1522df-bf68-461c-958c-2b7cb14b14e4`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NETWORK` | Yes | Deve ser `mainnet` |
| `BITFLOW_API_HOST` | Yes | `https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev` |
| `HIRO_API_KEY` | No | Hiro API key para rate limits maiores |

## Workflows

| Workflow | Frequency | Notes |
|----------|-----------|-------|
| [register-and-check-in](../../what-to-do/register-and-check-in.md) | Daily | |
| [check-balances-and-status](../../what-to-do/check-balances-and-status.md) | Daily | |
| [swap-tokens](../../what-to-do/swap-tokens.md) | As needed | Via Bitflow skill |

## Preferences

| Setting | Value | Notes |
|---------|-------|-------|
| Check-in frequency | 60 min | Standard loop interval |
| Preferred DEX | bitflow | Para token swaps |
| Fee tier | standard | |
| Auto-reply to inbox | disabled | |
