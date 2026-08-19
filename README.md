# SimpleShare v16 — bandwidth meter (plus everything from v15)

Includes the v15 quality fixes (contentHint, bitrate ceilings, live tile stats,
self-closing rooms). Deploy both halves; `/health` shows `"build":"budget-v16"`.

## The honest answer on the 1,000 GB

Cloudflare Realtime charges **$0.05/GB of egress**, with a **1,000 GB/month free
tier shared between SFU and TURN** -- not two separate allowances. Only traffic
from Cloudflare *to* clients is billed. Pushing your screen up to Cloudflare is
free.

So the cost formula is:

```
egress = sender bitrate x number of viewers
```

The sender is free. Each additional viewer is a full extra copy.

| Setup | Egress | 1,000 GB lasts |
|---|---|---|
| 720p30, 2 viewers | 2.3 GB/h | ~440 h |
| 720p60, 2 viewers | 3.6 GB/h | ~275 h |
| 1080p60, 2 viewers | 7.2 GB/h | ~140 h |
| 1080p60, 4 viewers | 14.4 GB/h | ~70 h |
| 3 streams @ 1080p60, 10-person room | 97 GB/h | **~10 h** |

You and two friends on 720p60: comfortable for months. The 10-person,
multi-stream, 1080p60 scenario from your original requirements would consume the
entire monthly allowance in a weekend.

I raised those ceilings in v15 to fix the slideshow without flagging the cost.
That was a real omission -- hence this release.

## What's new

**A live meter in the header** showing estimated egress (`~7.2 GB/h · session
0.43 GB`). It turns yellow above 8 GB/h and red above 20 GB/h. Hover it to see
roughly how many hours the free tier has left at the current rate.

**A warning when you pick an expensive profile.** Changing quality logs the
projected GB/h for the current number of viewers, and toasts if it exceeds
10 GB/h.

These are estimates from the bitrate ceilings, so real usage runs lower --
but the ceiling is what can ruin your month, and it was invisible until now.

## Recommended settings

- **720p60 + Motion** for games. Smooth, and roughly what Discord itself serves
  most users. About 1.8 GB/h per viewer.
- **1080p60** only for a couple of viewers, or short sessions.
- **Detail** hint only for code and documents, where sharp text beats smooth
  motion.

## Watch your actual usage

Estimates aren't billing. Check the real number at:
**Cloudflare dashboard → Realtime → SFU → Analytics**

Also worth doing now: set a **billing alert** on your Cloudflare account so
overage can never surprise you. At $0.05/GB, going 200 GB over costs $10 -- not
catastrophic, but you want to know before it happens rather than after.

## Still outstanding

The friend who can't share. I need his activity log, specifically the lines
after `publishing video track...`.
