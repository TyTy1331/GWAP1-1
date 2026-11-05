import { config } from './config.js';

export const isDoji = (c, pct = config.dojiBodyPct) => {
  const range = c.high - c.low;
  return range === 0 || Math.abs(c.close - c.open) < pct * range;
};
const bodyTop = (c) => Math.max(c.open, c.close);
const bodyBot = (c) => Math.min(c.open, c.close);

// Body pivots with two non-doji candles each side. A pivot is usable only after the
// second right-hand candle has closed (confirmedAt = that close), so there is no look-ahead.
export function findSwings(candles, tf) {
  const nd = candles.filter((c) => !isDoji(c));
  const swings = [];
  for (let i = 2; i < nd.length - 2; i++) {
    const c = nd[i], left = [nd[i - 2], nd[i - 1]], right = [nd[i + 1], nd[i + 2]];
    const confirmedAt = nd[i + 2].time + tf;
    // Strict on the left, ties allowed on the right: at a turn the next body usually opens at this close.
    if (left.every((s) => bodyTop(c) > bodyTop(s)) && right.every((s) => bodyTop(c) >= bodyTop(s))) {
      swings.push({ type: 'high', time: c.time, level: bodyTop(c), wick: Math.max(c.high, nd[i + 1].high), confirmedAt });
    }
    if (left.every((s) => bodyBot(c) < bodyBot(s)) && right.every((s) => bodyBot(c) <= bodyBot(s))) {
      swings.push({ type: 'low', time: c.time, level: bodyBot(c), wick: Math.min(c.low, nd[i + 1].low), confirmedAt });
    }
  }
  return swings;
}

// BOS: a candle close beyond the most recent confirmed swing's body level. Each swing breaks once.
export function findBos(candles, swings, tf) {
  const events = [];
  let hi = null, lo = null, k = 0;
  const sorted = [...swings].sort((a, b) => a.confirmedAt - b.confirmedAt);
  for (const c of candles) {
    while (k < sorted.length && sorted[k].confirmedAt <= c.time) {
      const s = sorted[k++];
      if (s.type === 'high') hi = s; else lo = s;
    }
    const close = c.time + tf;
    if (hi && c.close > hi.level) { events.push({ dir: 'bull', time: close, swing: hi }); hi = null; }
    else if (lo && c.close < lo.level) { events.push({ dir: 'bear', time: close, swing: lo }); lo = null; }
  }
  return events;
}

// Trend at time t: direction of the latest BOS at or before t, and how many in a row.
export function trendAt(bos, t) {
  let dir = null, count = 0;
  for (const e of bos) {
    if (e.time > t) break;
    if (e.dir === dir) count++; else { dir = e.dir; count = 1; }
  }
  return { dir, count };
}

export function analyze(candles, tf) {
  const swings = findSwings(candles, tf);
  return { swings, bos: findBos(candles, swings, tf) };
}

// Aligned with the 4H: one BOS is enough. Against (or unknown) 4H: two consecutive BOS.
export function isValid(dir, internal, external) {
  // A single 15m BOS against the 4H is only a pullback, so trades with the 4H stay valid.
  if (external.dir === dir && internal.dir && internal.dir !== dir && internal.count === 1) return true;
  if (internal.dir !== dir) return false;
  return external.dir === dir ? internal.count >= 1 : internal.count >= 2;
}
