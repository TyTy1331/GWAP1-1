import { config } from './config.js';
import { isDoji } from './structure.js';
import { noWickDir } from './nowick.js';

const round5 = (x) => Math.round(x * 1e5) / 1e5;
const pips = (d, pip) => Math.round((Math.abs(d) / pip) * 10) / 10;
const DEFAULT = { pip: config.pip, unit: config.pip, name: 'pips' };

// Unfilled same-direction pushes on the stop side of entry (they pull price toward the stop).
function voidsAgainst(dir, before, entry, unit) {
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
    const fast = run.length >= config.voidFastRun && Math.abs(last - first) >= config.voidFastPips * unit - 1e-9;
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
// inst: instrument(pair) — pip sizes and labels.
export function buildSetup({ dir, candles, swings, tf, recentLevels = [], stopAt, inst = DEFAULT }) {
  const nw = candles.at(-1);
  const entry = nw.open, isLong = dir === 'bull';
  const buffer = config.stopBufferPips * inst.unit;

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
  const riskPips = pips(entry - stop, inst.pip);

  const lo = Math.min(stop, tp), hi = Math.max(stop, tp);
  if (deeper.length) warnings.unshift(`Untapped ${word} no-wick at ${deeper.join(', ')} sat inside the normal stop — stop moved beyond the swing ${isLong ? 'low' : 'high'} at ${opposite.wick}`);
  for (const v of voidsAgainst(dir, candles.slice(0, -1), entry, inst.unit)) warnings.push(`Unfilled void against the trade at ${v.from}–${v.to}`);
  for (const l of recentLevels) {
    if (l.dir !== dir && l.level > lo && l.level < hi) warnings.push(`Conflicting ${l.dir === 'bull' ? 'bullish' : 'bearish'} no-wick at ${l.level}`);
  }
  const blocker = swings.find((s) => s.type === (isLong ? 'high' : 'low') && s.confirmedAt <= nw.time + tf
    && (isLong ? s.wick > entry && s.wick < tp : s.wick < entry && s.wick > tp));
  if (blocker) warnings.push(`TP is beyond a swing ${isLong ? 'high' : 'low'} at ${blocker.wick} — consider pulling TP in`);
  if (Math.abs(entry - stop) > config.largeStopPips * inst.unit + 1e-9) warnings.push(`Large stop: ${riskPips} ${inst.name}`);

  // structure: the swing the stop sits beyond, so the rule tests can try other buffers.
  return { entry, stop, altStop, tp, riskPips, warnings, structure: opposite.wick };
}

// Bard's imbalance play: an unfilled push in the opposite colour right in front of the trade (no swing in
// between) lets a counter-trend trade go after 1 BOS; TP at the far edge of the imbalance.
// Returns the nearest such zone { from, to } or null.
export function imbalanceAhead({ dir, candles, swings, tf, inst = DEFAULT }) {
  const nw = candles.at(-1), entry = nw.open, isLong = dir === 'bull';
  const zones = voidsAgainst(isLong ? 'bear' : 'bull', candles.slice(0, -1), entry, inst.unit)
    .filter((v) => (isLong ? v.from > entry : v.to < entry))
    .sort((a, b) => (isLong ? a.from - b.from : b.to - a.to));
  const z = zones[0];
  if (!z) return null;
  // "If there's structure in between, no": no swing between the entry and the imbalance's far edge (the target).
  const far = isLong ? z.to : z.from;
  const between = swings.some((s) => s.type === (isLong ? 'high' : 'low') && s.confirmedAt <= nw.time + tf
    && (isLong ? s.level > entry && s.level < far : s.level < entry && s.level > far));
  return between ? null : z;
}

// Where the no-wick sits in its leg: 0 = at the start (the pivot), 1 = at the far end. The leg runs from the
// pullback's extreme body since the last opposite swing to the furthest body after it.
// Bard pre-enters below 0.5; price is the 50% level he would enter at instead.
export function legPosition({ dir, candles, swings, tf }) {
  const nw = candles.at(-1), isLong = dir === 'bull';
  const last = swings.filter((s) => s.type === (isLong ? 'high' : 'low') && s.time < nw.time && s.confirmedAt <= nw.time + tf)
    .sort((a, b) => b.time - a.time)[0];
  const leg = candles.filter((c) => c.time > (last?.time ?? -Infinity)).slice(-config.voidLookback);
  const lo = (c) => Math.min(c.open, c.close), hi = (c) => Math.max(c.open, c.close);
  let k = 0;
  leg.forEach((c, i) => { if (isLong ? lo(c) < lo(leg[k]) : hi(c) > hi(leg[k])) k = i; });
  const start = isLong ? lo(leg[k]) : hi(leg[k]);
  const end = isLong ? Math.max(...leg.slice(k).map(hi)) : Math.min(...leg.slice(k).map(lo));
  if (end === start) return null;
  return { pos: Math.round(((nw.open - start) / (end - start)) * 100) / 100, price: round5((start + end) / 2) };
}

// Bard's lost trade (Nov 2026): a 15m setup against an untapped higher-timeframe no-wick that the higher
// timeframe's trend supports; "the one hour played out instead". higher: that timeframe's candles,
// base: the setup timeframe's candles, both up to the formation time t.
export function higherAgainst({ dir, higher, higherTf, trend, base, baseTf, t }) {
  const opp = dir === 'bull' ? 'bear' : 'bull';
  if (!higher?.length || trend?.dir !== opp) return null;
  const closed = higher.filter((c) => c.time + higherTf <= t).slice(-config.tapWindowCandles).reverse();
  for (const c of closed) {
    if (noWickDir(c) !== opp) continue;
    const after = base.filter((b) => b.time >= c.time + higherTf && b.time + baseTf <= t);
    const tapped = opp === 'bull' ? after.some((b) => b.low <= c.open) : after.some((b) => b.high >= c.open);
    if (!tapped) return { time: c.time, level: c.open, dir: opp };
  }
  return null;
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
