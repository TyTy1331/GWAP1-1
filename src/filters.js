import { config, instrument } from './config.js';

const fmtCache = new Map();
function parts(t, zone) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    fmtCache.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const inWindow = (t, w) => { const m = parts(t, w.zone).minutes; return m >= toMin(w.start) && m < toMin(w.end); };

export const localParts = parts;

export function sessionAt(t, sessions = config.sessions) {
  if (sessions.excluded.some((w) => inWindow(t, w))) return null;
  return sessions.allowed.find((w) => inWindow(t, w))?.name ?? null;
}

export function marketOpen(t, zone = config.marketZone) {
  const { weekday, minutes } = parts(t, zone);
  if (weekday === 'Sat') return false;
  if (weekday === 'Sun') return minutes >= 17 * 60;
  if (weekday === 'Fri') return minutes < 17 * 60;
  return true;
}

// Next daily close (17:00 New York) strictly after t.
export function nextDailyClose(t, zone = config.marketZone) {
  const m = Math.floor(t / 60) * 60;
  return m + (((17 * 60 - parts(m, zone).minutes + 1439) % 1440) + 1) * 60;
}

// Most recent Friday-17:00-NY close at or before t (NY offsets are whole hours, so 15-minute steps hit it exactly).
export function latestMarketClose(t) {
  let x = Math.floor(t / 900) * 900;
  for (let i = 0; i < 8 * 96; i++, x -= 900) if (!marketOpen(x) && marketOpen(x - 900)) return x;
  return null;
}

// Close time of the n-th market candle of size tf after `start` (a candle boundary).
export function addMarketBars(start, n, tf) {
  let x = start, count = 0;
  while (count < n) { if (marketOpen(x)) count++; x += tf; }
  return x;
}

// 1-based index of the market candle (size tf, counted from `start`) containing time t.
export function marketBarIndex(start, t, tf) {
  let n = 0;
  for (let x = start; x <= t; x += tf) if (marketOpen(x)) n++;
  return n;
}

export function marketMinutesBetween(a, b) {
  let n = 0;
  for (let x = a; x < b; x += 60) if (marketOpen(x)) n++;
  return n;
}

// ---- News (ForexFactory weekly feed) ----

export function parseNews(json) {
  const list = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(list)) throw new Error('news feed is not a list');
  return list
    .filter((e) => e.impact === 'High' && e.date)
    .map((e) => ({ t: Math.floor(Date.parse(e.date) / 1000), country: e.country, title: String(e.title ?? '') }))
    .filter((e) => Number.isFinite(e.t));
}

export async function refreshNews(cache, now, fetchFn = fetch) {
  if (cache?.ok && now - cache.fetchedAt < config.newsRefreshHours * 3600) return cache;
  try {
    const res = await fetchFn(config.newsUrl);
    if (!res.ok) throw new Error(`news HTTP ${res.status}`);
    return { ok: true, fetchedAt: now, events: parseNews(await res.text()) };
  } catch {
    return { ok: false, fetchedAt: cache?.fetchedAt ?? 0, events: cache?.events ?? [] };
  }
}

const forPair = (events, pair) => { const c = instrument(pair).currencies; return events.filter((e) => c.includes(e.country)); };

export function newsMute(events, pair, t) {
  const w = config.newsMuteMinutes * 60;
  return forPair(events, pair).some((e) => Math.abs(e.t - t) <= w);
}

export function upcomingNews(events, pair, t) {
  return forPair(events, pair).filter((e) => e.t > t && e.t <= t + config.newsAheadMinutes * 60);
}
