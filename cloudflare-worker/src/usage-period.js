const DAY = 86_400_000;

export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export function resetDay(value) {
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1;
}

export function monthlyPeriod(now, requestedDay = 1) {
  const day = resetDay(requestedDay);
  const date = new Date(now);
  const boundary = (offset) => {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + offset;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(day, last));
  };
  const start = boundary(0);
  return {
    start: start <= now ? start : boundary(-1),
    end: start <= now ? boundary(1) : start,
    resetDay: day,
  };
}

export function summarizeUsage(daily, now, period, resetAt = 0) {
  const start = Math.max(period.start, resetAt);
  let bytes = 0;
  for (const [date, count] of Object.entries(daily)) {
    if (date >= dayKey(start) && date <= dayKey(now)) bytes += Math.max(0, Number(count) || 0);
  }
  return {
    bytes,
    windowStart: dayKey(start),
    today: dayKey(now),
    windowDays: Math.ceil((period.end - period.start) / DAY),
  };
}

// Clip delayed room estimates at billing boundaries and manual resets.
export function addUsage(daily, { bytes, from, to }, now, period, resetAt = 0) {
  bytes = Number(bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const end = Number.isFinite(to) ? Math.min(to, now) : now;
  const begin = Number.isFinite(from) && from < end ? from : end;
  const clipped = Math.max(begin, period.start, resetAt);
  if (clipped > end || (clipped === end && begin < end)) return;
  if (begin === end) {
    daily[dayKey(end)] = (Number(daily[dayKey(end)]) || 0) + bytes;
    return;
  }
  for (let cursor = clipped; cursor < end;) {
    const key = dayKey(cursor);
    const next = Math.min(Date.parse(key) + DAY, end);
    daily[key] = (Number(daily[key]) || 0) + bytes * ((next - cursor) / (end - begin));
    cursor = next;
  }
}
