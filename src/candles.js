import { config } from './config.js';

export class FeedError extends Error {}

const TV_TF = { 60: '1', 900: '15', 1800: '30', 3600: '60', 14400: '240' };

export function credentialsFromEnv(env = process.env, warn = () => {}) {
  const { TV_SESSION: session, TV_SIGNATURE: signature } = env;
  if (session && signature) return { session, signature };
  if (session || signature) warn('Only one of TV_SESSION / TV_SIGNATURE is set; using anonymous TradingView access.');
  return undefined;
}

// Normalizes to {time, open, high, low, close, volume} in Unix seconds and drops the still-forming candle.
const r5 = (x) => Math.round(x * 1e5) / 1e5;
export function normalize(raw, tf, now) {
  return raw
    .map((c) => ({ time: c.time > 1e12 ? Math.floor(c.time / 1000) : c.time, open: r5(c.open), high: r5(c.high), low: r5(c.low), close: r5(c.close), volume: c.volume ?? 0 }))
    .filter((c) => c.time + tf <= now);
}

export function isFresh(oneMinute, now) {
  const last = oneMinute.at(-1);
  return Boolean(last) && now - (last.time + 60) < config.staleMinutes * 60;
}

let getCandlesImpl;
async function lib() {
  getCandlesImpl ??= (await import('@mathieuc/tradingview/data')).getCandles;
  return getCandlesImpl;
}

// The latest `count` candles. (A count query, not a `from` range: the library throws on
// empty ranges, and 500 1m bars already cover ~8h of catch-up; older gaps are reported.)
export async function fetchCandles({ pair, tf, count, now, credentials, getCandles }) {
  const query = { symbol: pair, timeframe: TV_TF[tf], count, credentials, timeoutMs: 20000 };
  let raw;
  try {
    raw = await (getCandles ?? (await lib()))(query);
  } catch (e) {
    // Library errors never carry credentials; keep only the message text.
    throw new FeedError(`TradingView ${pair} ${TV_TF[tf]}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  if (!raw?.length) throw new FeedError(`TradingView returned no ${TV_TF[tf]} candles for ${pair}`);
  return normalize(raw, tf, now);
}
