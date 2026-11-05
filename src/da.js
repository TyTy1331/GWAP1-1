// Decision areas (BardFX): low-volume price zones that produced big reactions over the past week.
// Found from a volume profile of the previous trading day, then checked with Bard's eye-test rules.
import { config, TF } from './config.js';
import { localParts } from './filters.js';

const round5 = (x) => Math.round(x * 1e5) / 1e5;
const mid = (z) => (z.lo + z.hi) / 2;
export const fmtZone = (z) => `${z.lo}–${z.hi}`;

// Open of the previous trading day (17:00 New York), skipping the weekend.
export function prevDayOpen(t) {
  const m = Math.floor(t / 60) * 60;
  const back = (localParts(m, config.marketZone).minutes - 17 * 60 + 1440) % 1440;
  const today = m - back * 60;
  return today - (localParts(today, config.marketZone).weekday === 'Sun' ? 3 : 1) * 86400;
}

// 1-pip rows: each candle's volume spread evenly over its range, then smoothed over 3 rows.
export function volumeProfile(candles, unit = config.pip) {
  const pip = unit, raw = new Map();
  for (const c of candles) {
    const lo = Math.round(c.low / pip), hi = Math.round(c.high / pip);
    const v = (c.volume || 1) / (hi - lo + 1); // no volume from the feed → time-at-price
    for (let k = lo; k <= hi; k++) raw.set(k, (raw.get(k) ?? 0) + v);
  }
  if (!raw.size) return { base: 0, vol: [] };
  const base = Math.min(...raw.keys()), n = Math.max(...raw.keys()) - base + 1;
  const r = Array.from({ length: n }, (_, i) => raw.get(base + i) ?? 0);
  const vol = r.map((_, i) => { const w = r.slice(Math.max(0, i - 1), i + 2); return w.reduce((a, b) => a + b, 0) / w.length; });
  return { base, vol };
}

// Prices of rows that are local minima and thin compared with the busiest row on each side.
export function valleys({ base, vol }, unit = config.pip) {
  const { valleyWindowPips: w, valleyRatio } = config.da, out = [];
  for (let i = 1; i < vol.length - 1; i++) {
    if (vol[i] > vol[i - 1] || vol[i] > vol[i + 1]) continue;
    const left = Math.max(...vol.slice(Math.max(0, i - w), i)), right = Math.max(...vol.slice(i + 1, i + 1 + w));
    if (vol[i] <= valleyRatio * left && vol[i] <= valleyRatio * right) out.push(round5((base + i) * unit));
  }
  return out;
}

// Bard's checks on 30m candles: widen over fake-outs, no consolidation inside, enough big reactions.
export function validate(zone, c30, unit = config.pip) {
  const d = config.da, pip = unit;
  let { lo, hi } = zone;
  const side = (x) => (x > hi ? 1 : x < lo ? -1 : 0);
  for (let changed = true; changed;) {
    changed = false;
    let last = 0; // side of the latest close outside the zone
    for (let k = 0; k < c30.length - 1; k++) {
      const s = side(c30[k].close);
      if (s && last === -s && side(c30[k + 1].close) === -s) { // closed through, then straight back
        if (s > 0) hi = c30[k].close; else lo = c30[k].close;
        changed = true;
        break;
      }
      if (s) last = s;
    }
    if (hi - lo > d.maxWidthPips * pip + 1e-9) return null;
  }
  let run = 0;
  for (const c of c30) {
    run = side(c.close) === 0 ? run + 1 : 0;
    if (run > d.maxInsideCloses) return null;
  }
  const away = d.reactionPips * pip;
  let reactions = 0, prevTouch = false;
  c30.forEach((c, k) => {
    const touch = c.low <= hi && c.high >= lo;
    if (touch && !prevTouch && c30.slice(k, k + 1 + d.reactionCandles).some((x) => x.high >= hi + away || x.low <= lo - away)) reactions++;
    prevTouch = touch;
  });
  return reactions >= d.minReactions ? { lo: round5(lo), hi: round5(hi), reactions } : null;
}

// Decision areas known at time t (a candle close), sorted low to high.
export function findDAs(m15 = [], m30 = [], t, unit = config.pip) {
  const d = config.da, half = d.zoneHalfPips * unit;
  const from = prevDayOpen(t);
  const prof = m15.filter((c) => c.time >= from && c.time + TF.M15 <= t);
  const c30 = m30.filter((c) => c.time >= t - d.validateDays * 86400 && c.time + TF.M30 <= t);
  if (prof.length < 8 || c30.length < 8) return [];
  const zones = valleys(volumeProfile(prof, unit), unit)
    .map((p) => validate({ lo: round5(p - half), hi: round5(p + half) }, c30, unit))
    .filter(Boolean);
  return spaced(zones, unit);
}

// Zones closer than minGapPips: keep the one with more reactions. Returns low to high.
export function spaced(zones, unit = config.pip) {
  const kept = [];
  for (const z of [...zones].sort((a, b) => b.reactions - a.reactions)) {
    if (kept.every((k) => Math.abs(mid(k) - mid(z)) >= config.da.minGapPips * unit)) kept.push(z);
  }
  return kept.sort((a, b) => a.lo - b.lo);
}

// Where a setup sits relative to the DAs. Mutates setup: adds warnings, info notes and journal fields.
export function applyDA(setup, dir, das) {
  const { entry, stop, tp } = setup, long = dir === 'bull';
  const inDA = das.find((z) => entry >= z.lo && entry <= z.hi);
  const below = das.filter((z) => mid(z) < entry).at(-1), above = das.find((z) => mid(z) > entry);
  const rangePos = below && above ? Math.round((100 * (entry - mid(below))) / (mid(above) - mid(below))) : null;
  const ahead = das.filter((z) => (long ? z.lo > entry && z.lo < tp : z.hi < entry && z.hi > tp));
  const tpBeyond = long ? ahead[0]?.lo : ahead.at(-1)?.hi;
  const guard = das.find((z) => (long ? z.hi < entry && z.lo > stop : z.lo > entry && z.hi < stop));
  const e = config.da.rangeEdgePct;

  if (inDA) setup.warnings.push(`Entry is inside a decision area (${fmtZone(inDA)})`);
  if (rangePos !== null && !long && rangePos <= e) setup.warnings.push(`Selling near the bottom of the range (${rangePos}%)`);
  if (rangePos !== null && long && rangePos >= 100 - e) setup.warnings.push(`Buying near the top of the range (${rangePos}%)`);
  if (tpBeyond !== undefined) setup.warnings.push(`TP is beyond a DA at ${tpBeyond} — consider TP just before it`);
  setup.notes = guard ? [`A DA between entry and stop protects it (${fmtZone(guard)})`] : [];
  setup.da = { below: below ? fmtZone(below) : '', above: above ? fmtZone(above) : '', rangePos, inDA: Boolean(inDA), tpBeyond: tpBeyond ?? '' };
  return setup;
}

// DA play: the nearest DA behind entry was touched in the last few 15m candles and held (no close through it).
export function daPlayZone(dir, candles, das) {
  const long = dir === 'bull', entry = candles.at(-1).open;
  const recent = candles.slice(-config.da.playLookback);
  const behind = das.filter((z) => (long ? z.hi <= entry : z.lo >= entry)).sort((a, b) => (long ? b.hi - a.hi : a.lo - b.lo));
  for (const z of behind) {
    const i = recent.findIndex((c) => (long ? c.low <= z.hi : c.high >= z.lo));
    if (i < 0) continue;
    if (recent.slice(i).some((c) => (long ? c.close < z.lo : c.close > z.hi))) continue;
    return z;
  }
  return null;
}
