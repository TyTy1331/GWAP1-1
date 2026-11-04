import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetup, recentNoWicks } from '../src/setup.js';
import { seq, move } from './helpers/candles.js';

const TF = 900;
const swing = (type, time, wick) => ({ type, time, level: wick, wick, confirmedAt: time + 3 * TF });

// filler candles ending with a no-wick at index n-1
function withNoWick(rows, nw) { return seq(0, TF, [...rows, nw]); }
const flat = Array.from({ length: 10 }, (_, i) => move(0.7005 + (i % 2) * 0.0001, 0.7006 - (i % 2) * 0.0001));

test('long: structure stop below the swing low with buffer, 1:1 TP', () => {
  const candles = withNoWick(flat, [0.7, 0.7008, 0.7, 0.7006]);
  const s = buildSetup({ dir: 'bull', candles, swings: [swing('low', 2 * TF, 0.699)], tf: TF });
  assert.equal(s.entry, 0.7);
  assert.equal(s.stop, 0.6989);
  assert.equal(s.tp, 0.7011);
  assert.equal(s.riskPips, 11);
});

test('short: same formula gives TP below entry', () => {
  const candles = withNoWick(flat, [0.7, 0.7, 0.6992, 0.6994]);
  const s = buildSetup({ dir: 'bear', candles, swings: [swing('high', 2 * TF, 0.701)], tf: TF });
  assert.equal(s.stop, 0.7011);
  assert.equal(s.tp, 0.6989);
});

test('no confirmed opposite swing: no setup', () => {
  const candles = withNoWick(flat, [0.7, 0.7008, 0.7, 0.7006]);
  assert.equal(buildSetup({ dir: 'bull', candles, swings: [], tf: TF }), null);
  const late = { ...swing('low', 2 * TF, 0.699), confirmedAt: 99 * TF };
  assert.equal(buildSetup({ dir: 'bull', candles, swings: [late], tf: TF }), null, 'not yet confirmed at formation');
});

test('alternative stop skips a doji previous candle', () => {
  const rows = [...flat.slice(0, 8), [0.7003, 0.7004, 0.6995, 0.7001], [0.7001, 0.7008, 0.6998, 0.70011]];
  const candles = withNoWick(rows, [0.7, 0.7008, 0.7, 0.7006]);
  const s = buildSetup({ dir: 'bull', candles, swings: [swing('low', 2 * TF, 0.699)], tf: TF });
  assert.equal(s.altStop, 0.6995);
});

test('AE6: unfilled bullish push below entry warns; bearish push above does not', () => {
  const push = [[0.6980, 0.6984, 0.6979, 0.6983], [0.6983, 0.6987, 0.6982, 0.6986], [0.6986, 0.6990, 0.6985, 0.6989],
    [0.6989, 0.6993, 0.6988, 0.6992], [0.6992, 0.6996, 0.6991, 0.6995]];
  const candles = withNoWick([...flat.slice(0, 3), ...push, move(0.6995, 0.7)], [0.7, 0.7008, 0.7, 0.7006]);
  const s = buildSetup({ dir: 'bull', candles, swings: [swing('low', 0, 0.6975)], tf: TF });
  assert.ok(s.warnings.some((w) => w.startsWith('Unfilled void') && w.includes('0.698')), s.warnings.join('|'));

  const dump = push.map(([o, h, l, c]) => [1.4 - o, 1.4 - l, 1.4 - h, 1.4 - c].map((x) => Math.round(x * 1e5) / 1e5));
  const above = withNoWick([...flat.slice(0, 3), ...dump.map((r) => r.map((x) => x + 0.0025)), move(0.7005, 0.7)], [0.7, 0.7008, 0.7, 0.7006]);
  const s2 = buildSetup({ dir: 'bull', candles: above, swings: [swing('low', 0, 0.6975)], tf: TF });
  assert.ok(!s2.warnings.some((w) => w.startsWith('Unfilled void')), s2.warnings.join('|'));
});

test('a filled void does not warn', () => {
  const push = [[0.6980, 0.6984, 0.6979, 0.6983], [0.6983, 0.6987, 0.6982, 0.6986], [0.6986, 0.6990, 0.6985, 0.6989],
    [0.6989, 0.6993, 0.6988, 0.6992], [0.6992, 0.6996, 0.6991, 0.6995]];
  const back = [[0.6995, 0.6996, 0.6978, 0.6985]]; // trades back to the push's first open
  const candles = withNoWick([...push, ...back, move(0.6985, 0.7)], [0.7, 0.7008, 0.7, 0.7006]);
  const s = buildSetup({ dir: 'bull', candles, swings: [swing('low', 0, 0.6975)], tf: TF });
  assert.ok(!s.warnings.some((w) => w.startsWith('Unfilled void')));
});

test('conflicting no-wick inside stop–TP warns, outside does not', () => {
  const candles = withNoWick(flat, [0.7, 0.7008, 0.7, 0.7006]);
  const sw = [swing('low', 2 * TF, 0.699)];
  const inside = buildSetup({ dir: 'bull', candles, swings: sw, tf: TF, recentLevels: [{ dir: 'bear', level: 0.7005 }] });
  assert.ok(inside.warnings.some((w) => w.startsWith('Conflicting bearish')));
  const outside = buildSetup({ dir: 'bull', candles, swings: sw, tf: TF, recentLevels: [{ dir: 'bear', level: 0.703 }] });
  assert.ok(!outside.warnings.some((w) => w.startsWith('Conflicting')));
});

test('TP beyond a swing high and large stop warn', () => {
  const candles = withNoWick(flat, [0.7, 0.7008, 0.7, 0.7006]);
  const s = buildSetup({ dir: 'bull', candles, swings: [swing('low', 2 * TF, 0.6977), swing('high', 3 * TF, 0.7012)], tf: TF });
  assert.equal(s.riskPips, 24);
  assert.ok(s.warnings.some((w) => w.startsWith('TP is beyond a swing high at 0.7012')));
  assert.ok(s.warnings.some((w) => w.startsWith('Large stop: 24')));
});

test('recentNoWicks lists only untapped levels', () => {
  // bear no-wick at 0.7 never revisited; bull no-wick at 0.6985 tapped by the next candle; last candle is the setup's own
  const candles = seq(0, TF, [[0.7, 0.7, 0.699, 0.6995], move(0.6995, 0.699), [0.6985, 0.6992, 0.6985, 0.699], move(0.699, 0.6982), move(0.6982, 0.6986), move(0.6986, 0.6988)]);
  const levels = recentNoWicks(candles);
  assert.deepEqual(levels, [{ dir: 'bear', level: 0.7 }]);
});
