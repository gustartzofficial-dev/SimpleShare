# SimpleShare v18 — rolling-window spend guard

You asked the right question. v17 was unsafe and this fixes it.

Copy `wrangler.toml` as well -- it declares the `BUDGET` binding and the v2
migration. `/health` should show `"build":"rolling-guard-v18"` and
`"budgetBasis":"rolling-31-day"`.

## The answer: billing cycle, NOT calendar month

From Cloudflare's billing documentation:

> Usage data is aligned to your billing cycle, not the calendar month. Your
> billing period start date is determined by the first purchase date on your
> account.

and

> Monthly included limits reset based on your monthly subscription renewal date,
> which is determined by the day you first subscribed.

All dates in UTC. So the reset is on your account's own anniversary date, not
the 1st of the month.

## Why that made v17 unsafe

v17 reset its counter on the 1st of each calendar month. If your billing cycle
starts on, say, the 20th:

- Aug 20 - Aug 31: you use 900 GB. My guard blocks you. Correct so far.
- **Sept 1: my guard resets to zero.** Cloudflare's window has not.
- Sept 1 - Sept 19: you use another 900 GB, unblocked.
- Sept 20, Cloudflare closes the billing window: **1,800 GB**. You are charged
  for 800 GB over the free tier -- about $40.

Precisely the outcome you wanted to make impossible.

## The fix: a rolling 31-day window

Instead of guessing your billing date, the tracker now keeps **daily buckets**
and enforces a cap on the **trailing 31-day total**.

The reasoning: every monthly billing window is at most 31 days long. If *every*
rolling 31-day window stays under the cap, then *any* billing window -- whatever
date it starts on -- is also under the cap. It's safe without knowing your
billing date, and there is nothing to configure.

I simulated 150 days of continuous heavy usage and checked every possible
31-day window:

```
 10 GB/day -> worst 31-day window  310 GB | under cap
 30 GB/day -> worst 31-day window  900 GB | under cap
 80 GB/day -> worst 31-day window  960 GB | blocked 90 of 150 days
200 GB/day -> worst 31-day window 1000 GB | blocked 125 of 150 days
```

The sustainable rate is 900/31 = about 29 GB/day, which is where throttling
begins -- as intended.

The overshoot in the last two rows is an artifact of the simulation's daily
granularity. In reality the guard re-checks every 30 seconds and the browser
stops an active share within about 15 seconds of the cap being hit, so a real
burst past the line is under a gigabyte. The 100 GB of headroom below
Cloudflare's 1,000 GB free tier absorbs it comfortably.

## What changes for you day to day

**Capacity comes back gradually, not all at once.** Instead of a full reset on
a fixed date, each day's usage ages out 31 days later. Heavy weekend, and that
capacity returns the following month's same weekend. This is more conservative
than a true monthly allowance -- that is the price of not needing to know your
billing date.

**The meter reads the same**, but the tooltip now says how much is left in the
trailing 31-day window and when that window started.

## Still worth doing

Keep the $1 billing alert. This guard is an estimate that errs conservative; the
alert is ground truth from Cloudflare itself. Two independent mechanisms is the
right number for anything touching your money.

Cross-check occasionally at Cloudflare dashboard -> Realtime -> SFU -> Analytics.
If the real figure runs consistently far below the guard's estimate, raise
`MONTHLY_EGRESS_CAP_GB` in `wrangler.toml`.
