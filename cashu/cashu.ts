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
import { randomUUID } from "node:crypto";
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
const LOCK_FILE = WALLET_FILE + ".lock";

interface PendingMelt { quote: string; amount: number; proofs: Proof[]; createdAt: string }
interface PendingSend { id: string; amount: number; token: string; proofs: Proof[]; createdAt: string }
interface MintState {
  proofs: Proof[];
  quotes: { quote: string; amount: number; request: string; createdAt: string; issuedElsewhere?: boolean }[];
  /** Inputs handed to a melt whose outcome is not yet known. Dropped only once the mint says SPENT. */
  pendingMelts?: PendingMelt[];
  /** Tokens made by `send` that the receiver may not have redeemed yet; `reclaim` swaps them back. */
  pendingSends?: PendingSend[];
}
type WalletFile = Record<string, MintState>;

const num = (a: unknown): number => Number((a as { toString(): string }).toString());
const sum = (ps: Proof[]): number => ps.reduce((s, p) => s + num(p.amount), 0);
const norm = (url: string): string => url.trim().replace(/\/+$/, "");
const upper = (s: unknown): string => String(s).toUpperCase();
// cashu-ts amounts serialize as strings; store plain numbers so the file stays a valid token source
const plain = (ps: Proof[]): Proof[] => ps.map((p) => ({ ...p, amount: num(p.amount) }) as Proof);

/** testnut and its variants (any scheme, port or subdomain) hand out fake sats. */
function isTestMint(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host === "testnut.cashu.space" || host.endsWith(".testnut.cashu.space");
  } catch {
    return false;
  }
}

/** On mainnet, tokens are only accepted from mints listed in CASHU_TRUSTED_MINTS (comma-separated) or passed with --trust-mint. */
function assertTrusted(mint: string, trustFlag?: string): void {
  if (NETWORK !== "mainnet") return;
  if (isTestMint(mint)) throw new Error("This token is from a test mint (fake sats).");
  const trusted = [...(process.env.CASHU_TRUSTED_MINTS ?? "").split(","), trustFlag ?? ""].map((m) => m && norm(m)).filter(Boolean);
  if (!trusted.includes(mint)) {
    throw new Error(`Mint ${mint} is not trusted. Anyone can run a mint that issues worthless ecash. If you trust it, add it to CASHU_TRUSTED_MINTS or pass --trust-mint ${mint}.`);
  }
}

function pickMint(opt?: string): string {
  const mint = opt ? norm(opt) : process.env.CASHU_MINT ? norm(process.env.CASHU_MINT) : undefined;
  if (NETWORK === "mainnet") {
    if (!mint) throw new Error("No mint given. Pass --mint <url> (or set CASHU_MINT) on mainnet.");
    if (isTestMint(mint)) throw new Error("testnut issues fake sats; it cannot be used on mainnet.");
  }
  return mint ?? TEST_MINT;
}

/** A missing file is an empty wallet. Anything else (bad JSON, permissions) must stop us before we overwrite real proofs. */
async function readWallet(): Promise<WalletFile> {
  let raw: string;
  try {
    raw = await fs.readFile(WALLET_FILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  try {
    return JSON.parse(raw) as WalletFile;
  } catch {
    throw new Error(`${WALLET_FILE} is not valid JSON. Nothing was changed; restore it from ${WALLET_FILE}.bak if needed (the .bak is the version before the last write, so it may miss the last operation).`);
  }
}

/** Write to a unique tmp file, fsync, keep the previous version as .bak, then rename into place. */
async function writeWallet(w: WalletFile): Promise<void> {
  await fs.mkdir(path.dirname(WALLET_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${WALLET_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fh = await fs.open(tmp, "w", 0o600);
    try {
      await fh.writeFile(JSON.stringify(w, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.copyFile(WALLET_FILE, WALLET_FILE + ".bak").catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
    await fs.rename(tmp, WALLET_FILE);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  // make the rename itself durable
  const dir = await fs.open(path.dirname(WALLET_FILE), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** Is a process with this pid alive on this host? */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Exclusive lock around read, operate and write, so two runs can't overwrite each other's proofs.
 * The lock file holds "<pid> <nonce>"; its mtime is refreshed every 20 s while we hold it. It is taken over
 * only when its pid is dead or its heartbeat stopped for 2 minutes, by renaming it to a unique name and
 * checking that we renamed the lock we inspected; on exit we remove it only if it still holds our nonce.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(LOCK_FILE), { recursive: true, mode: 0o700 });
  const mine = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const fh = await fs.open(LOCK_FILE, "wx", 0o600);
      await fh.writeFile(mine);
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const [seen, st] = await Promise.all([fs.readFile(LOCK_FILE, "utf8").catch(() => null), fs.stat(LOCK_FILE).catch(() => null)]);
      if (seen !== null && st && (!alive(Number(seen.split(" ")[0])) || Date.now() - st.mtimeMs > 120_000)) {
        const grave = `${LOCK_FILE}.stale-${randomUUID()}`;
        const moved = await fs.rename(LOCK_FILE, grave).then(() => true, () => false);
        if (moved) {
          const got = await fs.readFile(grave, "utf8").catch(() => null);
          // we grabbed a lock someone else just took: put it back if the slot is still free
          if (got !== seen) await fs.link(grave, LOCK_FILE).catch(() => {});
          await fs.unlink(grave).catch(() => {});
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Wallet is locked by another run (${LOCK_FILE}). If no other run is active, delete that file.`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const beat = setInterval(() => {
    const now = new Date();
    fs.utimes(LOCK_FILE, now, now).catch(() => {});
  }, 20_000);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    const cur = await fs.readFile(LOCK_FILE, "utf8").catch(() => null);
    if (cur === mine) await fs.unlink(LOCK_FILE).catch(() => {});
  }
}

type Save = () => Promise<void>;

/** Lock the wallet, load the mint's state, run `fn` (which may save mid-way), and save before printing anything. */
async function withMint<T>(mint: string, fn: (st: MintState, w: Wallet, save: Save) => Promise<T>): Promise<T> {
  return withLock(async () => {
    const file = await readWallet();
    const st = (file[mint] ??= { proofs: [], quotes: [] });
    st.pendingMelts ??= [];
    st.pendingSends ??= [];
    const w = new Wallet(mint, { unit: "sat" });
    await w.loadMint();
    const save = async () => {
      st.proofs = plain(st.proofs);
      await writeWallet(file);
    };
    try {
      return await fn(st, w, save);
    } finally {
      await save();
    }
  });
}

/** Read a bearer token from --token-file, or from stdin when the value is "-", so it stays out of `ps` and shell history. */
async function readToken(opts: { token?: string; tokenFile?: string }): Promise<string> {
  let t = opts.token;
  if (t !== undefined && t !== "-" && !opts.tokenFile) {
    throw new Error("Pass the token with --token-file <path> or --token - (stdin), not as a plain argument: argv is visible to other processes and shell history.");
  }
  if (opts.tokenFile) t = await fs.readFile(opts.tokenFile, "utf8");
  else if (t === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    t = Buffer.concat(chunks).toString("utf8");
  }
  if (!t?.trim()) throw new Error("Give the token with --token-file <path>, or --token - to read it from stdin.");
  return t.trim();
}

/**
 * Settle a melt whose result we did not see: inputs the mint reports UNSPENT come back to the wallet,
 * SPENT ones are gone (the invoice was paid), PENDING ones stay recorded for `reconcile`.
 */
async function settleMelt(st: MintState, w: Wallet, rec: PendingMelt): Promise<{ returned: number; spent: number; pending: number }> {
  const states = await w.checkProofsStates(rec.proofs);
  const back: Proof[] = [], still: Proof[] = [];
  let spent = 0;
  rec.proofs.forEach((p, i) => {
    const s = upper(states[i]?.state);
    if (s === "UNSPENT") back.push(p);
    else if (s === "SPENT") spent += num(p.amount);
    else still.push(p);
  });
  st.proofs.push(...back);
  rec.proofs = still;
  if (!still.length) st.pendingMelts = (st.pendingMelts ?? []).filter((m) => m !== rec);
  return { returned: sum(back), spent, pending: sum(still) };
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
      const active = ((keysets as { keysets?: { id: string; unit: string; active: boolean; input_fee_ppk?: number }[] }).keysets ?? []).filter((k) => k.active && k.unit === "sat");
      printJson({
        mint,
        name: (info as { name?: string }).name,
        version: (info as { version?: string }).version,
        supportedNuts: supported,
        canReceiveLightning: !!nuts["4"] && !nuts["4"].disabled,
        canPayLightning: !!nuts["5"] && !nuts["5"].disabled,
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
        mints: mints.map((m) => ({
          mint: m,
          sats: sum(file[m]?.proofs ?? []),
          proofs: file[m]?.proofs.length ?? 0,
          pendingInvoices: file[m]?.quotes.filter((q) => !q.issuedElsewhere).length ?? 0,
          issuedElsewhereInvoices: file[m]?.quotes.filter((q) => q.issuedElsewhere).length ?? 0,
          pendingMeltSats: sum((file[m]?.pendingMelts ?? []).flatMap((x) => x.proofs)),
          pendingSendSats: sum((file[m]?.pendingSends ?? []).flatMap((x) => x.proofs)),
        })),
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
      const out = await withMint(mint, async (st, w, save) => {
        const todo = st.quotes.filter((q) => (opts.quote ? q.quote === opts.quote : !q.issuedElsewhere));
        if (!todo.length) throw new Error(opts.quote ? `Unknown quote ${opts.quote} at ${mint}` : `No pending invoices at ${mint}`);
        const results = [];
        for (const q of todo) {
          let cur;
          try {
            cur = await w.checkMintQuoteBolt11(q.quote);
          } catch (e) {
            // one purged or unknown quote must not stop the others from being minted
            results.push({ quote: q.quote, state: "ERROR", minted: 0, error: e instanceof Error ? e.message : String(e) });
            continue;
          }
          if (cur.state === MintQuoteState.UNPAID) {
            results.push({ quote: q.quote, state: "UNPAID", minted: 0 });
            continue;
          }
          if (cur.state === MintQuoteState.PAID) {
            const proofs = await w.mintProofsBolt11(q.amount, cur);
            st.proofs.push(...proofs);
            st.quotes = st.quotes.filter((x) => x.quote !== q.quote);
            await save();
            results.push({ quote: q.quote, state: "MINTED", minted: sum(proofs) });
            continue;
          }
          // ISSUED but the proofs never reached this wallet (another wallet minted it, or a response was lost).
          // Keep the quote flagged instead of deleting it, so the paid amount stays visible.
          q.issuedElsewhere = true;
          results.push({ quote: q.quote, state: String(cur.state), minted: 0, note: "Issued, but the proofs are not in this wallet. Kept as issuedElsewhere; see balance." });
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
      const out = await withMint(mint, async (st, w, save) => {
        if (sum(st.proofs) < amount) throw new Error(`Not enough ecash at ${mint}: have ${sum(st.proofs)}, need ${amount} plus fees`);
        const { keep, send } = await w.ops.send(amount, st.proofs).includeFees(true).run();
        // the swap may have spent the old proofs: take keep + send into the wallet before anything else can throw
        st.proofs = [...keep, ...send];
        await save();
        const token = getEncodedToken({ mint, proofs: plain(send), memo: opts.memo });
        st.proofs = keep;
        // keep a copy until the receiver redeems it, so a lost stdout doesn't lose the money (`reclaim` swaps it back)
        const id = send[0]?.secret.slice(0, 12) ?? String(Date.now());
        st.pendingSends!.push({ id, amount, token, proofs: plain(send), createdAt: new Date().toISOString() });
        return { mint, amount, tokenSats: sum(send), token, sendId: id, balance: sum(keep) };
      });
      printJson(out);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("receive")
  .description("Redeem a token someone sent (swaps it at its mint, so the sender can no longer spend it)")
  .option("--token <cashuA|cashuB|->", "The token, or - to read it from stdin (keeps it out of ps and shell history)")
  .option("--token-file <path>", "Read the token from a file")
  .option("--trust-mint <url>", "On mainnet, accept tokens from this mint (otherwise it must be in CASHU_TRUSTED_MINTS)")
  .action(async (opts: { token?: string; tokenFile?: string; trustMint?: string }) => {
    try {
      const token = await readToken(opts);
      const meta = getTokenMetadata(token);
      const mint = norm(meta.mint);
      assertTrusted(mint, opts.trustMint);
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
      let maxFee: number | undefined;
      if (opts.maxFee !== undefined) {
        maxFee = Number(opts.maxFee);
        if (!/^\d+$/.test(opts.maxFee.trim()) || !Number.isSafeInteger(maxFee)) throw new Error("--max-fee must be a whole number of sats (0 or more)");
      }
      const out = await withMint(mint, async (st, w, save) => {
        const q = await w.createMeltQuoteBolt11(opts.invoice.trim());
        const amount = num(q.amount);
        const reserve = num(q.fee_reserve);
        const before = sum(st.proofs);
        if (before < amount + reserve) throw new Error(`Not enough ecash at ${mint}: have ${before}, need ${amount} + fee reserve ${reserve}`);
        // the cap covers everything this payment can cost: the Lightning fee reserve, the input fee of a swap
        // (if one is needed) and the melt's input fee. Check what we can before touching the mint.
        if (maxFee !== undefined && reserve > maxFee) {
          throw new Error(`Fee reserve ${reserve} sats is above --max-fee ${maxFee}`);
        }
        const { keep, send } = await w.ops.send(amount + reserve, st.proofs).includeFees(true).run();
        // the swap may have spent the old proofs: put keep + send in the wallet and save before anything can throw
        st.proofs = [...keep, ...send];
        await save();
        const swapFee = before - sum(keep) - sum(send);
        const inputFee = num(w.getFeesForProofs(send));
        if (maxFee !== undefined && reserve + swapFee + inputFee > maxFee) {
          // nothing is lost: the swapped proofs are already in the wallet
          throw new Error(`Fee reserve ${reserve} + swap fee ${swapFee} + input fee ${inputFee} sats is above --max-fee ${maxFee}; the wallet keeps the swapped proofs (balance ${sum(st.proofs)})`);
        }
        // Record the inputs as an in-flight melt and save BEFORE contacting the mint: if anything below
        // fails or the process dies, they are still on disk and `reconcile` can settle them.
        const rec: PendingMelt = { quote: q.quote, amount, proofs: plain(send), createdAt: new Date().toISOString() };
        st.proofs = keep;
        st.pendingMelts!.push(rec);
        await save();
        let res;
        try {
          res = await w.meltProofsBolt11(q, send);
        } catch (e) {
          // unknown outcome: return what the mint says is UNSPENT, keep PENDING (or unknown) inputs recorded
          const settled = await settleMelt(st, w, rec).catch(() => null);
          let tail = settled === null ? " Could not check the inputs; they are kept as a pending melt. Run `reconcile` later." : settled.pending ? ` ${settled.pending} sats are still PENDING at the mint; run \`reconcile\` later.` : "";
          if (settled && settled.spent > 0) {
            const qs = await w.checkMeltQuoteBolt11(q.quote).then((x) => upper(x.state)).catch(() => "unknown");
            tail += ` The mint marked ${settled.spent} sats of inputs SPENT (melt quote state ${qs}): the invoice was most likely paid. Do NOT retry; check the invoice first.`;
          }
          throw new Error(`${e instanceof Error ? e.message : String(e)}.${tail}`);
        }
        const state = upper(res.quote.state);
        if (state === "PAID") {
          st.pendingMelts = st.pendingMelts!.filter((m) => m !== rec);
          st.proofs.push(...(res.change ?? []));
          return { mint, paid: true, amount, feePaid: before - sum(st.proofs) - amount, preimage: res.quote.payment_preimage ?? null, balance: sum(st.proofs) };
        }
        if (state === "PENDING") {
          return { mint, paid: false, state, amount, pendingSats: sum(rec.proofs), balance: sum(st.proofs), next: `bun run cashu/cashu.ts reconcile --mint ${mint}` };
        }
        const settled = await settleMelt(st, w, rec);
        throw new Error(`The mint did not pay the invoice (state ${state}); ${settled.returned} sats returned to the wallet.`);
      });
      printJson(out);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("check-token")
  .description("Is a token still spendable? Read-only NUT-07 check, e.g. before accepting it as payment")
  .option("--token <cashuA|cashuB|->", "The token, or - to read it from stdin")
  .option("--token-file <path>", "Read the token from a file")
  .option("--trust-mint <url>", "On mainnet, accept tokens from this mint (otherwise it must be in CASHU_TRUSTED_MINTS)")
  .action(async (opts: { token?: string; tokenFile?: string; trustMint?: string }) => {
    try {
      const token = await readToken(opts);
      const meta = getTokenMetadata(token);
      const mint = norm(meta.mint);
      assertTrusted(mint, opts.trustMint);
      const w = new Wallet(mint, { unit: meta.unit ?? "sat" });
      await w.loadMint();
      const decoded = w.decodeToken(token);
      const states = await w.checkProofsStates(decoded.proofs);
      const unspent = decoded.proofs.filter((_, i) => upper(states[i]?.state) === "UNSPENT");
      // NUT-07 only says a secret hasn't been seen, so a forged proof also reads UNSPENT.
      // The NUT-12 DLEQ proves the mint signed it; without one we can't tell, so it doesn't count as spendable.
      const sig = await w.verifyMintSignatures(decoded.proofs, { require: true });
      const withoutDleq = decoded.proofs.filter((p) => !p.dleq).length;
      printJson({
        mint,
        unit: meta.unit ?? "sat",
        sats: sum(decoded.proofs),
        unspentSats: sum(unspent),
        dleqVerified: sig.invalid.length === 0,
        proofsWithoutDleq: withoutDleq,
        proofsWithBadDleq: sig.invalid.length - withoutDleq,
        spendable: unspent.length === decoded.proofs.length && sig.invalid.length === 0,
        note: sig.invalid.length ? "Not all proofs carry a valid mint signature proof (DLEQ). Only `receive` (a swap at the mint) settles it." : undefined,
        states: states.map((s) => String(s.state)),
        memo: meta.memo,
      });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("reconcile")
  .description("Settle in-flight payments and tidy sent tokens: inputs of melts the mint reports UNSPENT come back, SPENT ones are dropped, PENDING ones wait; redeemed sends are forgotten")
  .option("--mint <url>", "Mint URL")
  .action(async (opts: { mint?: string }) => {
    try {
      const mint = pickMint(opts.mint);
      const out = await withMint(mint, async (st, w) => {
        const melts = [];
        for (const rec of [...st.pendingMelts!]) {
          const quoteState = await w.checkMeltQuoteBolt11(rec.quote).then((q) => upper(q.state)).catch(() => "UNKNOWN");
          melts.push({ quote: rec.quote, amount: rec.amount, quoteState, ...(await settleMelt(st, w, rec)) });
        }
        const sends = [];
        for (const ps of [...st.pendingSends!]) {
          const states = await w.checkProofsStates(ps.proofs);
          const redeemed = states.every((x) => upper(x.state) === "SPENT");
          if (redeemed) st.pendingSends = st.pendingSends!.filter((x) => x !== ps);
          sends.push({ sendId: ps.id, amount: ps.amount, createdAt: ps.createdAt, redeemed });
        }
        return { mint, melts, sends, balance: sum(st.proofs) };
      });
      printJson(out);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("reclaim")
  .description("Take back a token made by `send` that the receiver has not redeemed (swaps its proofs back into the wallet)")
  .requiredOption("--send-id <id>", "sendId from `send` (see `reconcile` for the list)")
  .option("--mint <url>", "Mint URL")
  .action(async (opts: { sendId: string; mint?: string }) => {
    try {
      const mint = pickMint(opts.mint);
      const out = await withMint(mint, async (st, w) => {
        const ps = st.pendingSends!.find((x) => x.id === opts.sendId);
        if (!ps) throw new Error(`No unredeemed send ${opts.sendId} at ${mint}`);
        const states = await w.checkProofsStates(ps.proofs);
        const stateOf = (i: number) => upper(states[i]?.state);
        const unspent = ps.proofs.filter((_, i) => stateOf(i) === "UNSPENT");
        const pending = ps.proofs.filter((_, i) => stateOf(i) === "PENDING");
        const redeemed = sum(ps.proofs) - sum(unspent) - sum(pending);
        let reclaimed = 0;
        if (unspent.length) {
          const fresh = await w.receive(getEncodedToken({ mint, proofs: unspent }));
          st.proofs.push(...fresh);
          reclaimed = sum(fresh);
        }
        // proofs the receiver is melting right now may come back UNSPENT if that melt fails: keep tracking them
        if (pending.length) ps.proofs = pending;
        else st.pendingSends = st.pendingSends!.filter((x) => x !== ps);
        return {
          mint, sendId: ps.id, reclaimed, pendingSats: sum(pending),
          alreadyRedeemedSats: redeemed,
          balance: sum(st.proofs),
          ...(pending.length ? { next: `Some proofs are PENDING at the mint; run reclaim again later: bun run cashu/cashu.ts reclaim --send-id ${ps.id} --mint ${mint}` } : {}),
        };
      });
      printJson(out);
    } catch (e) {
      handleError(e);
    }
  });

program.parse();
