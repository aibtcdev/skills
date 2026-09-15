# sbor — subagent rules

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

**Read `largestConstituentWeight` before quoting.** Above about 0.9 the index is
one venue wearing a benchmark's name. Say so when you report it.

**Read utilisation before routing.** The cheapest rate at 95% utilisation may not
be drawable, and a withdrawal may not be available when you want it. Prefer a
venue with headroom.

**Do not add `supply` and `allInSupply`.** `allInSupply` already contains the
lending rate. Adding them double counts.

**Do not compare `poxReference` with a lending rate.** One is a staking yield on
a locked position, the other is the cost of a loan. They are different
instruments.

**Treat data older than 48 hours as stale.** Every payload carries a `fixing`
timestamp and every response carries `staleHours` and a `stale` flag. Past that,
fall back to your own logic rather than acting on it.

**Do not compare a Stacks rate with SOFR without saying why they differ.** A
dollar costs less to borrow on Stacks than in the US repo market. That is low
utilisation, not lower risk, and reporting it without that caveat is misleading.

**Inversions during `validating` are not a signal.** The status field says so.
Report them as observations, not as trades.

## Error handling

Every failure returns `{"error": "..."}` on stdout with a non-zero exit.

**If SBOR is unreachable, do not substitute an estimate.** A benchmark you
invented is worse than no benchmark. Say the rate is unavailable and fall back to
your own logic, or stop.

## What this skill will not do

It does not trade, hold, route or sign. It reads a public endpoint and returns
numbers. Any action is yours.
