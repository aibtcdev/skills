#!/usr/bin/env bun
/**
 * Cashu skill CLI
 * Ecash wallet for agents: pay and get paid over Lightning without running a node.
 * Proofs (bearer ecash) are kept per mint in ~/.aibtc/cashu/wallet.json (mode 600).
 *
 * Usage: bun run cashu/cashu.ts <subcommand> [options]
 */

import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Wallet,
  MintQuoteState,
  getEncodedToken,
  getTokenMetadata,
  type Proof,
} from "@cashu/cashu-ts";
import { NETWORK } from "@aibtc/skills/src/lib/config/networks.js";
import { getStorageDir } from "@aibtc/skills/src/lib/utils/storage.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

// testnut pays its own invoices with fake sats, so everything can be tried without money.
const TEST_MINT = "https://testnut.cashu.space";
const WALLET_FILE = path.join(getStorageDir(), "cashu", "wallet.json");

interface MintState {
  proofs: Proof[];
  quotes: { quote: string; amount: number; request: string; createdAt: string }[];
}
type WalletFile = Record<string, MintState>;

const num = (a: unknown): number => Number((a as { toString(): string }).toString());
const sum = (ps: Proof[]): number => ps.reduce((s, p) => s + num(p.amount), 0);
const norm = (url: string): string => url.trim().replace(/\/+$/, "");
// cashu-ts amounts serialize as strings; store plain numbers so the file stays a valid token source
const plain = (ps: Proof[]): Proof[] => ps.map((p) => ({ ...p, amount: num(p.amount) }) as Proof);

function pickMint(opt?: string): string {
  if (opt) return norm(opt);
  if (process.env.CASHU_MINT) return norm(process.env.CASHU_MINT);
  if (NETWORK === "mainnet") throw new Error("No mint given. Pass --mint <url> (or set CASHU_MINT) on mainnet.");
  return TEST_MINT;
}

async function readWallet(): Promise<WalletFile> {
  try {
    return JSON.parse(await fs.readFile(WALLET_FILE, "utf8")) as WalletFile;
  } catch {
    return {};
  }
}

async function writeWallet(w: WalletFile): Promise<void> {
  await fs.mkdir(path.dirname(WALLET_FILE), { recursive: true, mode: 0o700 });
  const tmp = WALLET_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(w, null, 2), { mode: 0o600 });
  await fs.rename(tmp, WALLET_FILE);
}

/** Load the mint's state, run `fn`, and save what it returns before printing anything. */
async function withMint<T>(mint: string, fn: (st: MintState, w: Wallet) => Promise<T>): Promise<T> {
  const file = await readWallet();
  const st = (file[mint] ??= { proofs: [], quotes: [] });
  const w = new Wallet(mint, { unit: "sat" });
  await w.loadMint();
  const save = async () => {
    st.proofs = plain(st.proofs);
    await writeWallet(file);
  };
  try {
    return await fn(st, w);
  } finally {
    await save();
  }
}

const program = new Command();
program
  .name("cashu")
  .description("Cashu ecash wallet: get paid and pay over Lightning through a mint, send and receive tokens")
  .version("0.1.0");

program
  .command("mint-info")
  .description("What a mint is (name, version), which NUTs it supports, its input fee and its active keysets")
  .option("--mint <url>", "Mint URL (default: testnut on testnet; required on mainnet)")
  .action(async (opts: { mint?: string }) => {
    try {
      const mint = pickMint(opts.mint);
      const [info, keysets] = await Promise.all([
        fetch(`${mint}/v1/info`).then((r) => r.json()),
        fetch(`${mint}/v1/keysets`).then((r) => r.json()),
      ]);
      const nuts = (info as { nuts?: Record<string, { supported?: boolean; disabled?: boolean; methods?: unknown[] }> }).nuts ?? {};
      const supported = Object.entries(nuts)
        .filter(([, v]) => v && (v.supported === true || (Array.isArray(v.methods) && !v.disabled)))
        .map(([k]) => k);
      const active = ((keysets as { keysets?: { id: string; unit: string; active: boolean; input_fee_ppk?: number }[] }).keysets ?? []).filter((k) => k.active);
      printJson({
        mint,
        name: (info as { name?: string }).name,
        version: (info as { version?: string }).version,
        supportedNuts: supported,
        canReceiveLightning: !nuts["4"]?.disabled,
        canPayLightning: !nuts["5"]?.disabled,
        spendingConditions: { p2pk: !!nuts["11"]?.supported, htlc: !!nuts["14"]?.supported },
        activeKeysets: active.map((k) => ({ id: k.id, unit: k.unit, inputFeePpk: k.input_fee_ppk ?? 0 })),
      });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("balance")
  .description("Ecash held at each mint (or one mint), and unpaid Lightning invoices")
  .option("--mint <url>", "Only this mint")
  .action(async (opts: { mint?: string }) => {
    try {
      const file = await readWallet();
      const mints = opts.mint ? [norm(opts.mint)] : Object.keys(file);
      printJson({
        network: NETWORK,
        mints: mints.map((m) => ({ mint: m, sats: sum(file[m]?.proofs ?? []), proofs: file[m]?.proofs.length ?? 0, pendingInvoices: file[m]?.quotes.length ?? 0 })),
        totalSats: mints.reduce((s, m) => s + sum(file[m]?.proofs ?? []), 0),
      });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("invoice")
  .description("Get paid: create a Lightning invoice at the mint (NUT-04). Once it is paid, run `claim` to turn it into ecash")
  .requiredOption("--amount <sats>", "Amount in sats")
  .option("--mint <url>", "Mint URL")
  .action(async (opts: { amount: string; mint?: string }) => {
    try {
      const amount = Number(opts.amount);
      if (!Number.isInteger(amount) || amount <= 0) throw new Error("--amount must be a positive whole number of sats");
      const mint = pickMint(opts.mint);
      const out = await withMint(mint, async (st, w) => {
        const q = await w.createMintQuoteBolt11(amount);
        st.quotes.push({ quote: q.quote, amount, request: q.request, createdAt: new Date().toISOString() });
        return { mint, quote: q.quote, amount, invoice: q.request, expiry: q.expiry, state: q.state, next: `bun run cashu/cashu.ts claim --mint ${mint} --quote ${q.quote}` };
      });
      printJson(out);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("claim")
  .description("Mint the ecash for paid invoices: one quote, or every pending quote at the mint")
  .option("--quote <id>", "Quote id from `invoice` (default: all pending at this mint)")
  .option("--mint <url>", "Mint URL")
  .action(async (opts: { quote?: string; mint?: string }) => {
    try {
      const mint = pickMint(opts.mint);
      const out = await withMint(mint, async (st, w) => {
        const todo = st.quotes.filter((q) => !opts.quote || q.quote === opts.quote);
        if (!todo.length) throw new Error(opts.quote ? `Unknown quote ${opts.quote} at ${mint}` : `No pending invoices at ${mint}`);
        const results = [];
        for (const q of todo) {
          const cur = await w.checkMintQuoteBolt11(q.quote);
          if (cur.state === MintQuoteState.UNPAID) {
            results.push({ quote: q.quote, state: "UNPAID", minted: 0 });
            continue;
          }
          let minted = 0;
          if (cur.state === MintQuoteState.PAID) {
            const proofs = await w.mintProofsBolt11(q.amount, cur);
            st.proofs.push(...proofs);
            minted = sum(proofs);
          }
          // ISSUED without our proofs means another wallet already minted it: nothing to retry
          st.quotes = st.quotes.filter((x) => x.quote !== q.quote);
          results.push({ quote: q.quote, state: minted ? "MINTED" : String(cur.state), minted });
        }
        return { mint, results, balance: sum(st.proofs) };
      });
      printJson(out);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("send")
  .description("Make a token worth --amount sats to hand to someone (the mint's input fee for redeeming it is included)")
  .requiredOption("--amount <sats>", "Amount in sats")
  .option("--memo <text>", "Memo carried in the token")
  .option("--mint <url>", "Mint URL")
  .action(async (opts: { amount: string; memo?: string; mint?: string }) => {
    try {
      const amount = Number(opts.amount);
      if (!Number.isInteger(amount) || amount <= 0) throw new Error("--amount must be a positive whole number of sats");
      const mint = pickMint(opts.mint);
      const out = await withMint(mint, async (st, w) => {
        if (sum(st.proofs) < amount) throw new Error(`Not enough ecash at ${mint}: have ${sum(st.proofs)}, need ${amount} plus fees`);
        const { keep, send } = await w.ops.send(amount, st.proofs).includeFees(true).run();
        st.proofs = keep;
        return { mint, amount, tokenSats: sum(send), token: getEncodedToken({ mint, proofs: plain(send), memo: opts.memo }), balance: sum(keep) };
      });
      printJson(out);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("receive")
  .description("Redeem a token someone sent (swaps it at its mint, so the sender can no longer spend it)")
  .requiredOption("--token <cashuA|cashuB>", "The token")
  .action(async (opts: { token: string }) => {
    try {
      const token = opts.token.trim();
      const meta = getTokenMetadata(token);
      const mint = norm(meta.mint);
      if (NETWORK === "mainnet" && mint === TEST_MINT) throw new Error("This token is from the test mint (fake sats).");
      const out = await withMint(mint, async (st, w) => {
        const fresh = await w.receive(token);
        st.proofs.push(...fresh);
        return { mint, received: sum(fresh), memo: meta.memo, balance: sum(st.proofs) };
      });
      printJson(out);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("pay")
  .description("Pay a Lightning invoice from ecash (NUT-05 melt). Change from the fee reserve comes back as ecash")
  .requiredOption("--invoice <bolt11>", "BOLT11 invoice")
  .option("--max-fee <sats>", "Refuse if the mint's fee reserve is above this")
  .option("--mint <url>", "Mint URL")
  .action(async (opts: { invoice: string; maxFee?: string; mint?: string }) => {
    try {
      const mint = pickMint(opts.mint);
      const out = await withMint(mint, async (st, w) => {
        const q = await w.createMeltQuoteBolt11(opts.invoice.trim());
        const amount = num(q.amount);
        const reserve = num(q.fee_reserve);
        if (opts.maxFee !== undefined && reserve > Number(opts.maxFee)) throw new Error(`Fee reserve ${reserve} sats is above --max-fee ${opts.maxFee}`);
        const before = sum(st.proofs);
        if (before < amount + reserve) throw new Error(`Not enough ecash at ${mint}: have ${before}, need ${amount} + fee reserve ${reserve}`);
        const { keep, send } = await w.ops.send(amount + reserve, st.proofs).includeFees(true).run();
        st.proofs = keep;
        try {
          const res = await w.meltProofsBolt11(q, send);
          st.proofs.push(...(res.change ?? []));
          const state = String(res.quote.state).toUpperCase();
          if (state !== "PAID") throw new Error(`The mint did not pay the invoice (state ${state})`);
          return { mint, paid: true, amount, feePaid: before - sum(st.proofs) - amount, preimage: res.quote.payment_preimage ?? null, balance: sum(st.proofs) };
        } catch (e) {
          // if the mint refused before paying, the inputs are still ours
          try {
            const states = await w.checkProofsStates(send);
            st.proofs.push(...send.filter((_, i) => String(states[i]?.state).toUpperCase() === "UNSPENT"));
          } catch {
            /* keep the original error */
          }
          throw e;
        }
      });
      printJson(out);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("check-token")
  .description("Is a token still spendable? Read-only NUT-07 check, e.g. before accepting it as payment")
  .requiredOption("--token <cashuA|cashuB>", "The token")
  .action(async (opts: { token: string }) => {
    try {
      const token = opts.token.trim();
      const meta = getTokenMetadata(token);
      const w = new Wallet(norm(meta.mint), { unit: meta.unit ?? "sat" });
      await w.loadMint();
      const decoded = w.decodeToken(token);
      const states = await w.checkProofsStates(decoded.proofs);
      const unspent = decoded.proofs.filter((_, i) => String(states[i]?.state).toUpperCase() === "UNSPENT");
      printJson({
        mint: norm(meta.mint),
        unit: meta.unit ?? "sat",
        sats: sum(decoded.proofs),
        unspentSats: sum(unspent),
        spendable: unspent.length === decoded.proofs.length,
        states: states.map((s) => String(s.state)),
        memo: meta.memo,
      });
    } catch (e) {
      handleError(e);
    }
  });

program.parse();
