# SimpleShare v17 — hard spending guard

You said you'd rather the app stop working than get charged. That is now
literally what happens.

## IMPORTANT: this release adds a new Durable Object

`wrangler.toml` is included and **must** be copied -- it declares the new
`BUDGET` binding and a `v2` migration. Deploying `src/index.js` without it will
fail.

```
cd cloudflare-worker && npx wrangler deploy
```

`/health` should show `"build":"spend-guard-v17"` and `"budgetBinding":true`.

## Why not LiveKit as a fallback

I checked the current numbers rather than guessing:

- **LiveKit Build (free): 50 GB/month egress** -- 5% of Cloudflare's 1,000 GB.
- **LiveKit overage: $0.10-$0.12/GB** -- more than double Cloudflare's $0.05.

So a LiveKit fallback would buy roughly five extra hours at 1080p60 and then
start charging you faster than Cloudflare would have. It also means maintaining
two media stacks, which is exactly what turned this project into a three-week
debugging saga. Not worth it.

Your own instinct was the better design: stop, don't fall back.

## How the guard works

**A single global `BudgetTracker` Durable Object** holds one counter for the
current UTC month.

**Every room meters itself.** Each active room ticks every 30 seconds and adds
`bitrate x viewers x elapsed` to that counter. It uses the profile *ceilings*,
so it deliberately **overestimates** -- it will cut you off early rather than
late.

**The Worker refuses to open new media** once the cap is hit. Requests to
`sessions/new` and `tracks/new` return `503`. Closing tracks and fetching ICE
servers still work, so existing sessions wind down cleanly instead of hanging.

**The month resets itself.** The period key is `YYYY-MM` in UTC, recomputed on
every read. When the month changes the counter resets to zero automatically --
no cron job, no manual step, and no way for it to reactivate early, because it
compares against the real current date every time.

**The cap is 900 GB**, set in `wrangler.toml` as `MONTHLY_EGRESS_CAP_GB`. That
leaves 100 GB of headroom under Cloudflare's 1,000 GB free tier for estimation
error. Lower it any time -- change the var and redeploy.

## What you'll see

The header meter now shows the real server-side figure: `312.4 / 900 GB · 3.6
GB/h`. Amber past 75%, red past 95%.

At the cap, a red banner appears, the share button is disabled, any active share
is stopped, and the log records it. Everyone in every room is blocked at the
same moment, because the counter is global rather than per-room.

New endpoint: `/api/budget` returns the live figures as JSON if you want to
check from your phone.

## Honest caveats

**These are estimates, not Cloudflare's billing.** The accounting assumes each
stream runs at its profile ceiling and that every participant watches every
stream. Reality is usually lower, which means the guard trips *before* you've
actually used 900 GB. That's the safe direction, but it does mean you may lose
some real headroom.

**Cross-check monthly** at Cloudflare dashboard -> Realtime -> SFU -> Analytics.
If the real number is consistently far below my estimate, raise the cap.

**Keep your $1 billing alert on.** This guard is a good belt; the alert is the
suspenders. Two independent mechanisms is the right number for something that
touches your money.

## If you ever need to reset the counter manually

The BudgetTracker accepts `POST /reset`. It isn't routed publicly on purpose --
if you want that as an admin endpoint later, say so and I'll add it behind a
secret.
