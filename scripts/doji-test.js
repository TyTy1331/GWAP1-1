// Compares the two doji definitions on recent history: the bot's (body under 10% of the range) and
// Bard's (both wicks bigger than the body). Dojis are ignored when finding structure, so the rule changes
// trends, which setups are valid, and where stops go. Run: node scripts/doji-test.js [candles]
// shortcut: trades are simulated on the setup timeframe's candles (not 1m), a candle touching both stop and
// TP counts as a loss, and news is not filtered (no history for it). Good enough to compare the two rules.
import { config, TF_LABEL, instrument } from '../src/config.js';
import { fetchCandles } from '../src/candles.js';
import { analyze, trendAt, isValid } from '../src/structure.js';
import { buildSetup, recentNoWicks } from '../src/setup.js';
import { noWickDir } from '../src/nowick.js';
import { sessionAt } from '../src/filters.js';

const COUNT = Number(process.argv[2] ?? 5000), now = Math.floor(Date.now() / 1000);

function simulate(base, i, dir, setup) {
  const bull = dir === 'bull', touch = (c) => (bull ? c.low <= setup.entry : c.high >= setup.entry);
  const stop = (c) => (bull ? c.low <= setup.stop : c.high >= setup.stop), tp = (c) => (bull ? c.high >= setup.tp : c.low <= setup.tp);
  let j = i + 1;
  for (; j <= i + config.tapWindowCandles && j < base.length && !touch(base[j]); j++);
  if (j > i + config.tapWindowCandles || j >= base.length) return null; // never tapped
  if (stop(base[j])) return -1; // in the tap candle only the stop counts
  for (let k = j + 1; k < Math.min(base.length, j + 200); k++) {
    if (stop(base[k])) return -1;
    if (tp(base[k])) return 1;
  }
  return null; // still open
}

function run(pair, base, ext, rule) {
  config.dojiRule = rule;
  const inst = instrument(pair), aBase = analyze(base, inst.tf), aExt = analyze(ext, inst.ext);
  const out = { trades: 0, w: 0, l: 0, ids: new Set() };
  for (let i = 500; i < base.length; i++) {
    const c = base[i], dir = noWickDir(c), t = c.time + inst.tf;
    if (!dir || !sessionAt(t)) continue;
    if (!isValid(dir, trendAt(aBase.bos, t), trendAt(aExt.bos, t), inst.pullback)) continue;
    const candles = base.slice(i - 499, i + 1);
    const setup = buildSetup({ dir, candles, swings: aBase.swings, tf: inst.tf, recentLevels: recentNoWicks(candles), inst });
    const r = setup && simulate(base, i, dir, setup);
    if (r === null || r === undefined) continue;
    out.trades++; out.ids.add(c.time);
    if (r > 0) out.w++; else out.l++;
  }
  return out;
}

const fmt = (o) => `${o.trades} trades ${o.w}W/${o.l}L ${o.trades ? Math.round((100 * o.w) / o.trades) : 0}% ${o.w - o.l >= 0 ? '+' : ''}${o.w - o.l}R`;
const total = { pct: { trades: 0, w: 0, l: 0 }, wicks: { trades: 0, w: 0, l: 0 } };
for (const pair of config.pairs) {
  const inst = instrument(pair);
  try {
    const base = await fetchCandles({ pair, tf: inst.tf, count: COUNT, now });
    const ext = await fetchCandles({ pair, tf: inst.ext, count: Math.ceil((COUNT * inst.tf) / inst.ext) + 500, now });
    const days = Math.round((base.at(-1).time - base[500].time) / 86400);
    const a = run(pair, base, ext, 'pct'), b = run(pair, base, ext, 'wicks');
    const same = [...a.ids].filter((id) => b.ids.has(id)).length;
    console.log(`${pair.split(':').pop()} ${TF_LABEL[inst.tf]} (${days} days)\n  now (10% body): ${fmt(a)}\n  Bard (wicks):   ${fmt(b)}\n  same setups in both: ${same}`);
    for (const k of ['trades', 'w', 'l']) { total.pct[k] += a[k]; total.wicks[k] += b[k]; }
  } catch (e) {
    console.log(`${pair}: ${e.message}`);
  }
}
console.log(`\nALL\n  now (10% body): ${fmt(total.pct)}\n  Bard (wicks):   ${fmt(total.wicks)}`);
