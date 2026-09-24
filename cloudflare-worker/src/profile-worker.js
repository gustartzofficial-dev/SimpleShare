import baseWorker, { RoomHub as CoreRoomHub } from './index.js';

const MAX_AVATAR_LENGTH = 55000;
const AVATAR_RE = /^data:image\/(?:webp|png|jpeg);base64,/i;
const DAY_MS = 86_400_000;
const DEFAULT_BILLING_PERIOD_DAYS = 30;
const RETAIN_DAYS = 75;

function safeAvatar(value) {
  const avatar = typeof value === 'string' ? value : '';
  if (!avatar) return '';
  if (avatar.length > MAX_AVATAR_LENGTH || !AVATAR_RE.test(avatar)) return '';
  return avatar;
}

function decodeMessage(raw) {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

function publicParticipant(participant) {
  return {
    id: participant.id,
    name: participant.name,
    joinedAt: participant.joinedAt,
    mode: participant.mode,
    avatar: participant.avatar || '',
  };
}

function budgetJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function readBudgetJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function utcDayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function parseDayKey(day) {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/*
 * Fixed-period bandwidth guard.
 *
 * The old BudgetTracker used a rolling 31-day total. That meant the visible
 * number never had a real monthly reset: old usage aged out one day at a time.
 * This tracker instead uses one cumulative allowance per fixed billing period.
 * At the next period boundary the visible usedGb total starts again from zero.
 *
 * Migration is intentionally non-destructive. The old `daily` buckets remain
 * the source of truth, and the first deployment derives a stable billing anchor
 * from the oldest retained bucket. If BILLING_CYCLE_ANCHOR_UTC is configured,
 * that explicit UTC date wins and lets the guard line up with Cloudflare's
 * billing cycle. The inferred/configured anchor is persisted so deploys do not
 * shift the reset date.
 */
export class BudgetTracker {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async buckets() {
    return (await this.ctx.storage.get('daily')) || {};
  }

  periodDays() {
    const configured = Number(this.env.BILLING_PERIOD_DAYS || DEFAULT_BILLING_PERIOD_DAYS);
    if (!Number.isFinite(configured)) return DEFAULT_BILLING_PERIOD_DAYS;
    return Math.max(1, Math.min(366, Math.floor(configured)));
  }

  async billingAnchor(daily, now = Date.now()) {
    const configuredRaw = String(this.env.BILLING_CYCLE_ANCHOR_UTC || '').trim();
    if (configuredRaw) {
      const parsed = Date.parse(configuredRaw);
      if (Number.isFinite(parsed) && parsed <= now) {
        const anchor = utcDayStart(parsed);
        const stored = await this.ctx.storage.get('billingAnchorUtc');
        if (stored !== anchor) await this.ctx.storage.put('billingAnchorUtc', anchor);
        return { anchor, source: 'configured' };
      }
    }

    const stored = Number(await this.ctx.storage.get('billingAnchorUtc'));
    if (Number.isFinite(stored) && stored > 0 && stored <= now) {
      return { anchor: utcDayStart(stored), source: 'stored' };
    }

    const oldest = Object.keys(daily)
      .map(parseDayKey)
      .filter(v => Number.isFinite(v) && v <= now)
      .sort((a, b) => a - b)[0];

    const anchor = Number.isFinite(oldest) ? oldest : utcDayStart(now);
    await this.ctx.storage.put('billingAnchorUtc', anchor);
    return { anchor, source: Number.isFinite(oldest) ? 'migrated-oldest-usage' : 'first-use' };
  }

  currentPeriod(anchor, now, periodDays) {
    const periodMs = periodDays * DAY_MS;
    const elapsed = Math.max(0, now - anchor);
    const index = Math.floor(elapsed / periodMs);
    const start = anchor + index * periodMs;
    const end = start + periodMs;
    return { index, start, end, periodMs };
  }

  summarize(daily, period) {
    let bytes = 0;
    for (const [day, value] of Object.entries(daily)) {
      const dayMs = parseDayKey(day);
      if (!Number.isFinite(dayMs)) continue;
      if (dayMs >= period.start && dayMs < period.end) bytes += Number(value) || 0;
    }
    return bytes;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const capGb = Math.max(1, Number(this.env.MONTHLY_EGRESS_CAP_GB || 900));
    const periodDays = this.periodDays();
    let daily = await this.buckets();
    let now = Date.now();

    if (url.pathname === '/add' && request.method === 'POST') {
      const body = await readBudgetJson(request);
      const bytes = Number(body.bytes);
      if (Number.isFinite(bytes) && bytes > 0) {
        const today = isoDay(now);
        daily[today] = (Number(daily[today]) || 0) + bytes;

        // Keep enough history for migration/debugging without allowing the
        // Durable Object record to grow forever. Current-period accounting only
        // needs the active period, but two periods of history are useful.
        const keepFrom = isoDay(now - RETAIN_DAYS * DAY_MS);
        for (const day of Object.keys(daily)) if (day < keepFrom) delete daily[day];
        await this.ctx.storage.put('daily', daily);
      }
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      // Internal/manual reset path retained for compatibility. It starts a new
      // billing period now rather than merely erasing the number and leaving the
      // old period anchor behind.
      daily = {};
      now = Date.now();
      await this.ctx.storage.put('daily', daily);
      await this.ctx.storage.put('billingAnchorUtc', utcDayStart(now));
    }

    const { anchor, source: anchorSource } = await this.billingAnchor(daily, now);
    const period = this.currentPeriod(anchor, now, periodDays);
    const bytes = this.summarize(daily, period);
    const usedGb = bytes / 1e9;
    const roundedUsed = Math.round(usedGb * 1000) / 1000;
    const remaining = Math.max(0, Math.round((capGb - usedGb) * 1000) / 1000);
    const daysRemaining = Math.max(0, Math.ceil((period.end - now) / DAY_MS));

    return budgetJson({
      usedGb: roundedUsed,
      capGb,
      remainingGb: remaining,
      percent: Math.min(100, Math.round((usedGb / capGb) * 1000) / 10),
      blocked: usedGb >= capGb,

      // Keep windowDays for older frontends whose blocked banner references it.
      // It now means fixed billing-period length, NOT a rolling window.
      windowDays: periodDays,
      periodDays,
      periodStart: new Date(period.start).toISOString(),
      periodEnd: new Date(period.end).toISOString(),
      resetAt: new Date(period.end).toISOString(),
      daysRemaining,
      today: isoDay(now),
      basis: 'fixed-billing-period',
      anchorSource,
    });
  }
}

/*
 * Add room-scoped profile pictures without touching the media transport.
 * The existing RoomHub still owns join/auth/signaling/stream state; this class
 * only persists one small avatar string on the participant record and announces
 * profile changes over the socket that already exists.
 */
export class RoomHub extends CoreRoomHub {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/join') {
      let requestedAvatar = '';
      try {
        const body = await request.clone().json();
        requestedAvatar = safeAvatar(body.avatar);
      } catch {}

      const response = await super.fetch(request);
      if (!response.ok || !requestedAvatar) return response;

      try {
        const joined = await response.clone().json();
        const state = await this.getState();
        const participant = state.participants[joined.participantId];
        if (participant && participant.token === joined.token && participant.avatar !== requestedAvatar) {
          participant.avatar = requestedAvatar;
          const rev = await this.putState(state);
          this.broadcast({ type: 'participant-updated', rev, participant: publicParticipant(participant) });
        }
      } catch {}
      return response;
    }

    return super.fetch(request);
  }

  async webSocketMessage(ws, raw) {
    const msg = decodeMessage(raw);
    if (!msg) return super.webSocketMessage(ws, raw);

    const attachment = ws.deserializeAttachment() || {};
    const participantId = attachment.participantId;

    if (msg.type === 'profile-update' && participantId) {
      const state = await this.getState();
      const participant = state.participants[participantId];
      if (!participant) return;

      const avatar = safeAvatar(msg.avatar);
      if (avatar) participant.avatar = avatar;
      else delete participant.avatar;

      const rev = await this.putState(state);
      this.broadcast({ type: 'participant-updated', rev, participant: publicParticipant(participant) });
      return;
    }

    // Keep the original rename behavior, then immediately publish the same
    // participant with its avatar attached so clients can remap the picture to
    // the new display name without waiting for a snapshot.
    if (msg.type === 'rename' && participantId) {
      await super.webSocketMessage(ws, raw);
      const state = await this.getState();
      const participant = state.participants[participantId];
      if (participant?.avatar) {
        this.broadcast({ type: 'participant-updated', rev: state.rev || 0, participant: publicParticipant(participant) });
      }
      return;
    }

    return super.webSocketMessage(ws, raw);
  }
}

// Keep the existing Worker router, but correct the health metadata so a live
// deployment makes the billing mode explicit instead of claiming rolling-31-day.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await baseWorker.fetch(request, env, ctx);
    if (url.pathname !== '/health' || !response.ok) return response;

    try {
      const data = await response.clone().json();
      const headers = new Headers(response.headers);
      headers.set('content-type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify({
        ...data,
        budgetBasis: 'fixed-billing-period',
        budgetPeriodDays: Math.max(1, Math.min(366, Math.floor(Number(env.BILLING_PERIOD_DAYS || DEFAULT_BILLING_PERIOD_DAYS)))),
      }), { status: response.status, headers });
    } catch {
      return response;
    }
  },
};
