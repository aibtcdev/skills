---
name: sbor
skill: sbor
description: Rules for using the sbor skill. When to call it before a lending action, how to read a verdict, and when to refuse rather than act on it.
---

# sbor: subagent rules

Read-only. No wallet, no funds, no keys, nothing to lose. Call it freely.

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

**Never treat a missing index as zero.** If `rate` says an index is not
published, that means the market could not be read. It is unknown, not free. Do
not infer a rate from an absence.

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

**Inversions during `validating` are not a signal.** The status field says so.
Report them as observations, not as trades.

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

**`compare` is designed to refuse.** It exits non-zero on stale or unparseable
data, an unpublished index, a missing rate, or input outside 0 to 100 percent. A
non-zero exit from `compare` means there is no trustworthy answer, not that the
rate is bad. Do not proceed as though the check passed.

## What this skill will not do

It does not trade, hold, route or sign. It reads a public endpoint and returns
numbers. Any action is yours.
