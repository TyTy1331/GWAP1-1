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
    // the push starts at its extreme open (lowest for a bullish push, highest for a bearish one)
    const opens = win.slice(i, end + 1).map((c) => c.open);
    const start = i + opens.indexOf(dir === 'bull' ? Math.min(...opens) : Math.max(...opens));
    const run = win.slice(start, end + 1);
    if (run.length >= config.voidMinRun) {
      const first = run[0].open, last = run.at(-1).close;
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
export function buildSetup({ dir, candles, swings, tf, recentLevels = [] }) {
  const nw = candles.at(-1);
  const entry = nw.open, isLong = dir === 'bull';
  const buffer = config.stopBufferPips * config.pip;

  const opposite = swings
    .filter((s) => s.type === (isLong ? 'low' : 'high') && s.confirmedAt <= nw.time + tf && s.time < nw.time)
    .filter((s) => (isLong ? s.wick < entry : s.wick > entry))
    .sort((a, b) => b.time - a.time)[0];
  if (!opposite) return null;

  const stop = round5(isLong ? opposite.wick - buffer : opposite.wick + buffer);
  const tp = round5(entry + (entry - stop));
  const prev = candles.slice(0, -1).reverse().find((c) => !isDoji(c));
  const alt = prev ? round5(isLong ? prev.low : prev.high) : null;
  const altStop = alt !== null && (isLong ? alt < entry : alt > entry) ? alt : null;
  const riskPips = pips(entry - stop);

  const lo = Math.min(stop, tp), hi = Math.max(stop, tp);
  const warnings = [];
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

// Untapped opposite-direction no-wick levels among the last N candles before the no-wick.
export function recentNoWicks(candles) {
  const before = candles.slice(0, -1), out = [];
  const start = Math.max(0, before.length - config.conflictLookback);
  for (let i = start; i < before.length; i++) {
    const d = noWickDir(before[i]);
    if (!d) continue;
    const level = before[i].open, later = candles.slice(i + 1);
    const tapped = d === 'bull' ? later.some((c) => c.low <= level) : later.some((c) => c.high >= level);
    if (!tapped) out.push({ dir: d, level });
  }
  return out;
}
