#!/usr/bin/env bun
/**
 * payout-reconciler — Reconcile aibtc.news earnings vs on-chain sBTC transfers
 *
 * Core value: "Verify every sat. Trust the chain, not the API."
 *
 * Usage:
 *   bun payout-reconciler/payout-reconciler.ts reconcile <btc-address> [--stx-address <stx>]
 *   bun payout-reconciler/payout-reconciler.ts audit-prizes <btc-address> [--stx-address <stx>]
 *   bun payout-reconciler/payout-reconciler.ts summary <btc-address> [--stx-address <stx>]
 */

import { Command } from "commander";

// ─── Constants ────────────────────────────────────────────────────────────────

const AIBTC_NEWS_API = "https://aibtc.news/api";
const HIRO_API = "https://api.hiro.so";
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const KNOWN_PAYOUT_ADDRESS = "SP1KGHF33817ZXW27CG50JXWC0Y6BNXAQ4E7YGAHM";
const FETCH_TIMEOUT_MS = 20_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message: unknown): never {
  console.log(JSON.stringify({ error: String(message) }, null, 2));
  process.exit(1);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Earning {
  id: string;
  btc_address: string;
  amount_sats: number;
  reason: string;
  reference_id: string;
  created_at: string;
  payout_txid: string | null;
  voided_at: string | null;
}

interface StatusResponse {
  address: string;
  streak: { current_streak: number; last_signal_date: string } | null;
  earnings: Earning[];
  totalSignals: number;
  display_name: string | null;
}

interface HiroTransaction {
  tx_id: string;
  tx_type: string;
  sender_address: string;
  block_height: number;
  burn_block_time_iso?: string;
  contract_call?: {
    contract_id: string;
    function_name: string;
    function_args: Array<{ name: string; repr: string }>;
  };
}

interface HiroTxResponse {
  results: HiroTransaction[];
  total: number;
  limit: number;
  offset: number;
}

interface IncomingTransfer {
  txid: string;
  amount_sats: number;
  from: string;
  block_height: number;
  is_payout_address: boolean;
  timestamp?: string;
}

interface Discrepancy {
  type: "amount_mismatch" | "missing_on_chain" | "unrecorded_transfer" | "null_payout_txid";
  earning_id?: string;
  reason?: string;
  api_amount?: number;
  on_chain_amount?: number;
  difference?: number;
  txid?: string;
  detail: string;
}

// ─── Core Functions ───────────────────────────────────────────────────────────

async function getEarnings(btcAddress: string): Promise<StatusResponse> {
  return fetchJson<StatusResponse>(
    `${AIBTC_NEWS_API}/status/${encodeURIComponent(btcAddress)}`
  );
}

async function getIncomingTransfers(
  stxAddress: string,
  limit = 50
): Promise<IncomingTransfer[]> {
  const transfers: IncomingTransfer[] = [];
  let offset = 0;
  const maxPages = 3; // Cap at 150 transactions to avoid excessive API calls

  for (let page = 0; page < maxPages; page++) {
    const data = await fetchJson<HiroTxResponse>(
      `${HIRO_API}/extended/v1/address/${stxAddress}/transactions?limit=${limit}&offset=${offset}`
    );

    for (const tx of data.results) {
      // Skip outgoing transactions
      if (tx.sender_address === stxAddress) continue;

      if (tx.tx_type === "contract_call" && tx.contract_call) {
        const cc = tx.contract_call;
        if (
          cc.contract_id.toLowerCase().includes("sbtc") &&
          cc.function_name === "transfer"
        ) {
          const args: Record<string, string> = {};
          for (const a of cc.function_args) {
            args[a.name] = a.repr;
          }

          // Check if recipient is this address
          if (args.recipient?.includes(stxAddress)) {
            const amount = parseInt(args.amount?.replace("u", "") ?? "0", 10);
            transfers.push({
              txid: tx.tx_id,
              amount_sats: amount,
              from: tx.sender_address,
              block_height: tx.block_height,
              is_payout_address: tx.sender_address === KNOWN_PAYOUT_ADDRESS,
              timestamp: tx.burn_block_time_iso,
            });
          }
        }
      }
    }

    if (data.results.length < limit) break;
    offset += limit;
  }

  return transfers;
}

function findDiscrepancies(
  earnings: Earning[],
  transfers: IncomingTransfer[]
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  // Check each earning entry
  for (const e of earnings) {
    if (e.voided_at) continue;

    // Null payout_txid
    if (!e.payout_txid) {
      discrepancies.push({
        type: "null_payout_txid",
        earning_id: e.id.slice(0, 12),
        reason: e.reason,
        api_amount: e.amount_sats,
        detail: `${e.reason} (${e.amount_sats} sats) has no payout_txid — cannot verify on-chain delivery`,
      });
      continue;
    }

    // Has txid — check if on-chain amount matches
    const cleanTxid = e.payout_txid.startsWith("0x")
      ? e.payout_txid
      : `0x${e.payout_txid}`;
    const matchingTx = transfers.find((t) => t.txid === cleanTxid);

    if (!matchingTx) {
      discrepancies.push({
        type: "missing_on_chain",
        earning_id: e.id.slice(0, 12),
        reason: e.reason,
        api_amount: e.amount_sats,
        txid: cleanTxid.slice(0, 18) + "...",
        detail: `API records payout_txid ${cleanTxid.slice(0, 18)}... but tx not found in ${transfers.length}-tx on-chain window — may be older than scan range or invalid`,
      });
    } else if (matchingTx.amount_sats !== e.amount_sats) {
      discrepancies.push({
        type: "amount_mismatch",
        earning_id: e.id.slice(0, 12),
        reason: e.reason,
        api_amount: e.amount_sats,
        on_chain_amount: matchingTx.amount_sats,
        difference: matchingTx.amount_sats - e.amount_sats,
        txid: matchingTx.txid.slice(0, 18) + "...",
        detail: `API records ${e.amount_sats} sats but on-chain tx shows ${matchingTx.amount_sats} sats (${matchingTx.amount_sats > e.amount_sats ? "under-reported" : "over-reported"} by ${Math.abs(matchingTx.amount_sats - e.amount_sats)} sats)`,
      });
    }
  }

  // Check for payout-address transfers not matched to any earning
  const recordedTxids = new Set(
    earnings
      .filter((e) => e.payout_txid)
      .map((e) =>
        e.payout_txid!.startsWith("0x")
          ? e.payout_txid!
          : `0x${e.payout_txid!}`
      )
  );

  for (const t of transfers) {
    if (t.is_payout_address && !recordedTxids.has(t.txid)) {
      discrepancies.push({
        type: "unrecorded_transfer",
        on_chain_amount: t.amount_sats,
        txid: t.txid.slice(0, 18) + "...",
        detail: `On-chain transfer of ${t.amount_sats} sats from payout address (block ${t.block_height}) has no matching earnings API entry`,
      });
    }
  }

  return discrepancies;
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("payout-reconciler")
  .description(
    "Verify every sat. Reconcile aibtc.news earnings vs on-chain sBTC."
  )
  .version("1.0.0");

// ─── reconcile ────────────────────────────────────────────────────────────────

program
  .command("reconcile <btc-address>")
  .description(
    "Full reconciliation of earnings API vs on-chain sBTC transfers."
  )
  .option(
    "--stx-address <stx>",
    "STX address for on-chain lookup (required if not auto-resolvable)"
  )
  .action(async (btcAddress: string, opts: { stxAddress?: string }) => {
    try {
      if (!btcAddress.startsWith("bc1"))
        fail("Address must start with bc1");

      const status = await getEarnings(btcAddress);
      const earnings = (status.earnings ?? []).filter((e) => !e.voided_at);

      const apiTotal = earnings.reduce((s, e) => s + e.amount_sats, 0);
      const withTxid = earnings.filter((e) => e.payout_txid);
      const withoutTxid = earnings.filter((e) => !e.payout_txid);

      // On-chain reconciliation
      let onChainData = null;
      let discrepancies: Discrepancy[] = [];
      let gap = null;

      if (opts.stxAddress) {
        const transfers = await getIncomingTransfers(opts.stxAddress);
        const payoutTransfers = transfers.filter((t) => t.is_payout_address);
        const otherTransfers = transfers.filter((t) => !t.is_payout_address);
        const onChainTotal = transfers.reduce(
          (s, t) => s + t.amount_sats,
          0
        );
        const payoutTotal = payoutTransfers.reduce(
          (s, t) => s + t.amount_sats,
          0
        );

        onChainData = {
          stx_address: opts.stxAddress,
          total_incoming_sats: onChainTotal,
          payout_address_sats: payoutTotal,
          transfer_count: transfers.length,
          from_payout_address: payoutTransfers.length,
          from_other: otherTransfers.length,
        };

        discrepancies = findDiscrepancies(earnings, transfers);

        gap = {
          api_total: apiTotal,
          on_chain_payout_total: payoutTotal,
          on_chain_all_total: onChainTotal,
          difference: onChainTotal - apiTotal,
          direction:
            onChainTotal > apiTotal
              ? "on_chain_higher"
              : onChainTotal < apiTotal
                ? "api_higher"
                : "match",
        };
      } else {
        // API-only analysis (no STX address)
        for (const e of earnings) {
          if (!e.payout_txid && !e.voided_at) {
            discrepancies.push({
              type: "null_payout_txid",
              earning_id: e.id.slice(0, 12),
              reason: e.reason,
              api_amount: e.amount_sats,
              detail: `${e.reason} (${e.amount_sats} sats) — no payout_txid recorded`,
            });
          }
        }
      }

      out({
        skill: "payout-reconciler",
        command: "reconcile",
        timestamp: new Date().toISOString(),
        address: btcAddress,
        display_name: status.display_name,
        streak: status.streak?.current_streak ?? 0,
        total_signals: status.totalSignals,
        earnings_api: {
          total_entries: earnings.length,
          total_sats: apiTotal,
          with_payout_txid: withTxid.length,
          without_payout_txid: withoutTxid.length,
          by_reason: earnings.reduce(
            (acc, e) => {
              acc[e.reason] = (acc[e.reason] ?? 0) + e.amount_sats;
              return acc;
            },
            {} as Record<string, number>
          ),
        },
        on_chain: onChainData,
        discrepancies,
        discrepancy_count: discrepancies.length,
        gap,
        note: opts.stxAddress
          ? "Full reconciliation complete. Discrepancies array shows all mismatches between API and chain."
          : "API-only analysis. Provide --stx-address for full on-chain reconciliation.",
        hint:
          discrepancies.length === 0
            ? "Clean — no discrepancies found."
            : `${discrepancies.length} discrepancies found. See discrepancies array for details.`,
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── audit-prizes ─────────────────────────────────────────────────────────────

program
  .command("audit-prizes <btc-address>")
  .description("Audit weekly prize entries against on-chain transfers.")
  .option("--stx-address <stx>", "STX address for on-chain lookup")
  .action(async (btcAddress: string, opts: { stxAddress?: string }) => {
    try {
      if (!btcAddress.startsWith("bc1"))
        fail("Address must start with bc1");

      const status = await getEarnings(btcAddress);
      const prizes = (status.earnings ?? []).filter(
        (e) => e.reason.includes("prize") && !e.voided_at
      );

      if (prizes.length === 0) {
        out({
          skill: "payout-reconciler",
          command: "audit-prizes",
          address: btcAddress,
          display_name: status.display_name,
          prizes: [],
          note: "No weekly prize entries found for this correspondent.",
        });
        return;
      }

      const results = [];

      for (const p of prizes) {
        const entry: Record<string, unknown> = {
          earning_id: p.id.slice(0, 12),
          reason: p.reason,
          reference: p.reference_id,
          api_amount_sats: p.amount_sats,
          payout_txid: p.payout_txid,
          created_at: p.created_at,
        };

        // If we have a txid and stx address, verify on-chain amount
        if (p.payout_txid && opts.stxAddress) {
          const cleanTxid = p.payout_txid.startsWith("0x")
            ? p.payout_txid.slice(2)
            : p.payout_txid;
          try {
            const tx = await fetchJson<{
              contract_call?: {
                function_args: Array<{ name: string; repr: string }>;
              };
            }>(`${HIRO_API}/extended/v1/tx/0x${cleanTxid}`);

            if (tx.contract_call) {
              const amountArg = tx.contract_call.function_args.find(
                (a) => a.name === "amount"
              );
              if (amountArg) {
                const onChainAmount = parseInt(
                  amountArg.repr.replace("u", ""),
                  10
                );
                entry.on_chain_amount_sats = onChainAmount;
                entry.match = onChainAmount === p.amount_sats;
                if (onChainAmount !== p.amount_sats) {
                  entry.difference = onChainAmount - p.amount_sats;
                  entry.multiplier = `${(onChainAmount / p.amount_sats).toFixed(1)}x`;
                  entry.verdict = "MISMATCH — API under-reports actual prize";
                } else {
                  entry.verdict = "MATCH";
                }
              }
            }
          } catch {
            entry.on_chain_lookup = "failed";
          }
        }

        results.push(entry);
      }

      out({
        skill: "payout-reconciler",
        command: "audit-prizes",
        timestamp: new Date().toISOString(),
        address: btcAddress,
        display_name: status.display_name,
        prizes: results,
        note: "Prize amounts in the API may use pre-set design values, not actual payouts. On-chain amounts are authoritative.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── summary ──────────────────────────────────────────────────────────────────

program
  .command("summary <btc-address>")
  .description(
    "Quick summary: API earnings total, wallet balance, gap percentage."
  )
  .option("--stx-address <stx>", "STX address for balance lookup")
  .action(async (btcAddress: string, opts: { stxAddress?: string }) => {
    try {
      if (!btcAddress.startsWith("bc1"))
        fail("Address must start with bc1");

      const status = await getEarnings(btcAddress);
      const earnings = (status.earnings ?? []).filter((e) => !e.voided_at);
      const apiTotal = earnings.reduce((s, e) => s + e.amount_sats, 0);
      const nullCount = earnings.filter((e) => !e.payout_txid).length;

      let walletBalance: number | null = null;

      if (opts.stxAddress) {
        try {
          const ftData = await fetchJson<{
            fungible_tokens: Record<string, { balance: string }>;
          }>(
            `${HIRO_API}/extended/v1/address/${opts.stxAddress}/balances`
          );
          const sbtcKey = Object.keys(ftData.fungible_tokens ?? {}).find((k) =>
            k.toLowerCase().includes("sbtc")
          );
          if (sbtcKey) {
            walletBalance = parseInt(ftData.fungible_tokens[sbtcKey].balance, 10);
          }
        } catch {
          // Balance lookup failed — continue with API-only summary
        }
      }

      out({
        skill: "payout-reconciler",
        command: "summary",
        timestamp: new Date().toISOString(),
        address: btcAddress,
        display_name: status.display_name,
        streak: status.streak?.current_streak ?? 0,
        api_earnings_sats: apiTotal,
        api_entries: earnings.length,
        null_payout_txid: nullCount,
        null_percentage: earnings.length > 0
          ? `${Math.round((nullCount / earnings.length) * 100)}%`
          : "n/a",
        wallet_balance_sats: walletBalance,
        gap_sats: walletBalance !== null ? walletBalance - apiTotal : null,
        verdict:
          nullCount === 0
            ? "All earnings have confirmed payout_txid"
            : `${nullCount}/${earnings.length} earnings lack payout confirmation (Issue #338)`,
        note: "API earnings may under-report actual payouts. Use 'reconcile' with --stx-address for full on-chain audit.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse(process.argv);
