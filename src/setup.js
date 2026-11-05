import { config } from './config.js';
import { isDoji } from './structure.js';
import { noWickDir } from './nowick.js';

const round5 = (x) => Math.round(x * 1e5) / 1e5;
const pips = (d) => Math.round((Math.abs(d) / config.pip) * 10) / 10;

// Unfilled same-direction pushes on the stop side of entry (they pull price toward the stop).
function voidsAgainst(dir, before, entry) {
  const want = dir === 'bull' ? 'up' : 'down';
  const color = (c) => (c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat');
  const out = [];
  const win = before.slice(-config.voidLookback);
  for (let i = 0; i < win.length;) {
    if (color(win[i]) !== want) { i++; continue; }
    // extend the push, allowing at most one opposite/flat candle inside it
    let j = i + 1, odd = 0;
    while (j < win.length && (color(win[j]) === want || odd++ === 0)) j++;
    let end = j - 1;
    while (color(win[end]) !== want) end--;
    // the push starts at its latest extreme open (lowest for a bullish push, highest for a bearish one)
    const opens = win.slice(i, end + 1).map((c) => c.open);
    const start = i + opens.lastIndexOf(dir === 'bull' ? Math.min(...opens) : Math.max(...opens));
    const run = win.slice(start, end + 1);
    const first = run[0].open, last = run.at(-1).close;
    const fast = run.length >= config.voidFastRun && Math.abs(last - first) >= config.voidFastPips * config.pip - 1e-9;
    if (run.length >= config.voidMinRun || fast) {
      const rest = win.slice(start + 1); // any later trade back to the push's start fills it
      const filled = dir === 'bull' ? rest.some((c) => c.low <= first) : rest.some((c) => c.high >= first);
      const sideOk = dir === 'bull' ? last <= entry : last >= entry;
      if (!filled && sideOk) out.push({ from: round5(Math.min(first, last)), to: round5(Math.max(first, last)) });
      i = end + 1;
    } else i++;
  }
  return out;
}

// candles: this timeframe's closed candles, ending with the no-wick candle. swings: from analyze().
// stopAt: a price to put the stop beyond instead of the latest opposite swing (DA plays).
export function buildSetup({ dir, candles, swings, tf, recentLevels = [], stopAt }) {
  const nw = candles.at(-1);
  const entry = nw.open, isLong = dir === 'bull';
  const buffer = config.stopBufferPips * config.pip;

  // Latest opposite swing beyond a price, confirmed by the close of the candle at `at`.
  const swingBeyond = (price, at = nw.time) => swings
    .filter((s) => s.type === (isLong ? 'low' : 'high') && s.confirmedAt <= at + tf && s.time < at)
    .filter((s) => (isLong ? s.wick < price : s.wick > price))
    .sort((a, b) => b.time - a.time)[0];
  let opposite = stopAt !== undefined ? { wick: stopAt } : swingBeyond(entry);
  if (!opposite) return null;

  // An untapped same-direction no-wick on the stop side is likely to be tapped first (a deeper pullback).
  // If it is still a live entry (inside its tap window) and sits inside the stop, the stop goes beyond
  // the swing that protected it when it formed. Otherwise it's a warning.
  // shortcut: age is counted in this timeframe's candles and ignores upgrades of the older level.
  const word = isLong ? 'bullish' : 'bearish';
  const sameSide = recentLevels.filter((l) => l.dir === dir && (isLong ? l.level < entry : l.level > entry))
    .sort((a, b) => Math.abs(a.level - entry) - Math.abs(b.level - entry));
  const deeper = [], warnings = [];
  for (const l of sameSide) {
    const inside = isLong ? l.level >= opposite.wick - buffer : l.level <= opposite.wick + buffer;
    const live = (l.age ?? 0) <= config.tapWindowCandles;
    const cover = inside && live && stopAt === undefined ? swingBeyond(l.level, l.time ?? nw.time) : null;
    if (cover) { opposite = cover; deeper.push(l.level); }
    else warnings.push(`Untapped ${word} no-wick ${isLong ? 'below' : 'above'} at ${l.level} — price may pull back to it`);
  }

  const stop = round5(isLong ? opposite.wick - buffer : opposite.wick + buffer);
  const tp = round5(entry + (entry - stop));
  const prev = candles.slice(0, -1).reverse().find((c) => !isDoji(c));
  const alt = prev ? round5(isLong ? prev.low : prev.high) : null;
  const altStop = alt !== null && (isLong ? alt < entry : alt > entry) ? alt : null;
  const riskPips = pips(entry - stop);

  const lo = Math.min(stop, tp), hi = Math.max(stop, tp);
  if (deeper.length) warnings.unshift(`Untapped ${word} no-wick at ${deeper.join(', ')} sat inside the normal stop — stop moved beyond the swing ${isLong ? 'low' : 'high'} at ${opposite.wick}`);
  for (const v of voidsAgainst(dir, candles.slice(0, -1), entry)) warnings.push(`Unfilled void against the trade at ${v.from}–${v.to}`);
  for (const l of recentLevels) {
    if (l.dir !== dir && l.level > lo && l.level < hi) warnings.push(`Conflicting ${l.dir === 'bull' ? 'bullish' : 'bearish'} no-wick at ${l.level}`);
  }
  const blocker = swings.find((s) => s.type === (isLong ? 'high' : 'low') && s.confirmedAt <= nw.time + tf
    && (isLong ? s.wick > entry && s.wick < tp : s.wick < entry && s.wick > tp));
  if (blocker) warnings.push(`TP is beyond a swing ${isLong ? 'high' : 'low'} at ${blocker.wick} — consider pulling TP in`);
  if (riskPips > config.largeStopPips) warnings.push(`Large stop: ${riskPips} pips`);

  return { entry, stop, altStop, tp, riskPips, warnings };
}

// Untapped no-wick levels (either direction) among the last N candles before the no-wick; age in candles.
export function recentNoWicks(candles) {
  const before = candles.slice(0, -1), out = [];
  const start = Math.max(0, before.length - config.conflictLookback);
  for (let i = start; i < before.length; i++) {
    const d = noWickDir(before[i]);
    if (!d) continue;
    const level = before[i].open, later = candles.slice(i + 1);
    const tapped = d === 'bull' ? later.some((c) => c.low <= level) : later.some((c) => c.high >= level);
    if (!tapped) out.push({ dir: d, level, time: before[i].time, age: before.length - i });
  }
  return out;
}
