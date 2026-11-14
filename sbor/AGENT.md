---
name: sbor
skill: sbor
description: Rules for using the sbor skill. When to call it before a lending action, how to read a verdict, and when to refuse rather than act on it.
---

# sbor: subagent rules

Read-only. No wallet, no funds, no keys, nothing to lose. Call it freely.

Mainnet only, built in: it always reads mainnet, whatever `NETWORK` is set to, and says so in every answer (`"network": "mainnet"`).

## When to call it

**Before any lending action.** Borrowing, supplying, looping or routing on
Stacks is a decision about whether a rate is good. Call `compare` first.

**When a user asks whether a rate is good.** That is what this exists for.

**When picking between venues.** Call `markets` and read utilisation, not just
the rate.

**Before quoting a Stacks rate to anyone.** Rates move daily.

## Decision rules

**Use it as a guardrail, not an oracle.** A sensible pattern: if an offered
borrow rate is more than 50 basis points above SBOR, stop and ask a human rather
than proceeding. Route around the offer, do not override the check.

**Never treat a missing index as zero.** If an index is not published, read
`reason`. Either SBOR could not read the market, or it withheld the index
(`withheld: true`) and gives its own reason, such as a rate at or near zero
on-chain. Either way, do not infer a rate from an absence.

**A withdrawn fixing is not a reading, and a gap is not a value.** `rate --date`
returns `withdrawn: true` and the reason instead of the figure, and so do
`markets` and `chains` for the current fixing. If a response says
`withdrawalCheck: "unconfirmed"`, the record of withdrawals has not caught up
with the fixing yet: read it again before acting. `history` lists the days an
index was not published in `notPublished`, each with SBOR's reason: the series
has gaps there.

**A market with `excluded: true` is not part of the rate.** It carries weight 0
today. Never route to it because its rate is the lowest listed.

**A stale inversion is not live.** If `inversions` returns `stale: true`, the
check ran on an old fixing, whatever its `status` says.

**Read `venueCount` before quoting, not the weight.** An index covering one venue
is a reading of that venue, not a market average, whatever the constituent
weights say. SBOR-STX is single venue today with a largest weight of about 0.56,
so weight alone would miss it. `compare` returns `venueCount` and sets
`concentrationNote` when it is 1.

**Read utilisation before routing.** The cheapest rate at 95% utilisation may not
be drawable, and a withdrawal may not be available when you want it. Prefer a
venue with headroom.

**Do not add `supply` and `allInSupply`.** `allInSupply` already contains the
lending rate. Adding them double counts.

**Judge a supply offer that includes staking yield by `allInVerdict`.** On the
supply side, `compare` returns `allInSupply`, `allInDifferenceBps` and
`allInVerdict` when an index has an all-in rate. `verdict` is against the lending
rate alone.

**Do not compare `poxReference` with a lending rate.** One is a staking yield on
a locked position, the other is the cost of a loan. They are different
instruments.

**Staleness is enforced, not just reported.** `compare` exits non-zero on data
older than 48 hours or on a timestamp it cannot parse, rather than returning a
verdict you might act on. Reporting commands still return, with `staleHours`,
`stale` and a `staleNote`. If `stale` is true, do not act on the number.

**Do not compare a Stacks rate with SOFR without saying why they differ.** A
dollar costs less to borrow on Stacks than in the US repo market. That is low
utilisation, not lower risk, and reporting it without that caveat is misleading.

**Inversions are observations, not trades.** The monitor is live since 2 October
2026, but rates are compared before fees and gas, and an inversion can close
before you act.

**Use the right benchmark.** For a USDC loan against bitcoin, on any chain,
compare with `BTC-COLLATERAL-USDC`, never a Stacks index; `compare`
adds a hint when a Stacks index may be the wrong one.

**A market still phasing in is not a recommendation.** In
`BTC-COLLATERAL-USDC`, a market with `phaseIn` below 1 is listed but carries
less weight, and its rate can be mechanically low for weeks while its rate
model adjusts. `compare` never names it as the best constituent. Nor a market
at zero weight (borrower incentives, for example): it is listed by `markets`
but is not part of the rate, and it does not count in `venues`.

**Every verdict is market data, not financial advice.** `compare` says so in
`notAdvice`; pass it on.

**Pass rates as percentages.** `--rate 4.2` means 4.2%. Passing 0.042 means
0.042%, which is a rate that genuinely occurs on Stacks, so it cannot be
rejected outright. It is answered and flagged with `unitsWarning`, and the
`plain` sentence opens with the same warning. **If you see `unitsWarning`, check
which you meant before acting.**

**Never average across a methodology change.** `history` reports
`byMethodologyVersion` and withholds a single `meanBorrow` when the window spans
more than one version. A mean across a change in how the number is built is not
a mean of anything.

## Error handling

Every failure returns `{"error": "..."}` on stdout with a non-zero exit.

**If SBOR is unreachable, do not substitute an estimate.** A benchmark you
invented is worse than no benchmark. Say the rate is unavailable and fall back to
your own logic, or stop. Requests time out after 10 seconds.

**`rate --date` reads the archive.** Its output carries `historical: true` and the archive file as `source`, and is never marked stale: it is the record of that day. An invalid date, or one the archive does not hold (before 2026-09-03, today before the day's fixing, or after the latest), is an input error, not a missing rate.

**`compare` is designed to refuse.** It exits non-zero on stale or unparseable
data, a fixing dated in the future, an unpublished index, a missing rate, or input outside 0 to 100 percent. A
non-zero exit from `compare` means there is no trustworthy answer, not that the
rate is bad. Do not proceed as though the check passed.

## What this skill will not do

It does not trade, hold, route or sign. It reads a public endpoint and returns
numbers. Any action is yours.
