import test from 'node:test';
import assert from 'node:assert/strict';
import { legPosition, higherAgainst, imbalanceAhead } from '../src/setup.js';
import { formatEvent } from '../src/telegram.js';
import { whyText } from '../src/why.js';
import { freshState } from '../src/state.js';
import { isDoji } from '../src/structure.js';
import { config } from '../src/config.js';
import { utc } from './helpers/candles.js';

const c = (k, open, close, extra = {}) => ({ time: k * 900, open, close, high: Math.max(open, close) + 0.0002, low: Math.min(open, close) - 0.0002, ...extra });
const nwBull = (k, open, close) => ({ time: k * 900, open, close, low: open, high: close + 0.0001 });
const swingHigh = { type: 'high', time: 0, level: 0.701, wick: 0.7012, confirmedAt: 0 };

test('pre-entry: a no-wick at the start of its leg sits at 0%, one halfway up at 50%', () => {
  const atPivot = [c(1, 0.701, 0.7005), c(2, 0.7005, 0.7), nwBull(3, 0.7, 0.7008)];
  assert.deepEqual(legPosition({ dir: 'bull', candles: atPivot, swings: [swingHigh], tf: 900 }), { pos: 0, price: 0.7004 });
  const midLeg = [c(1, 0.7005, 0.7), c(2, 0.7, 0.7004), nwBull(3, 0.7004, 0.7008)];
  assert.equal(legPosition({ dir: 'bull', candles: midLeg, swings: [swingHigh], tf: 900 }).pos, 0.5);
});

test('higher timeframe: an untapped, trend-backed opposite no-wick is reported; tapped or against its trend is not', () => {
  const h = [{ time: 0, open: 0.702, high: 0.702, low: 0.7005, close: 0.701 }]; // bearish 1H no-wick at 0.702
  const base = [c(4, 0.701, 0.7012), c(5, 0.7012, 0.7015)];
  const args = { dir: 'bull', higher: h, higherTf: 3600, trend: { dir: 'bear', count: 1 }, base, baseTf: 900, t: 6 * 900 };
  assert.deepEqual(higherAgainst(args), { time: 0, level: 0.702, dir: 'bear' });
  assert.equal(higherAgainst({ ...args, trend: { dir: 'bull', count: 2 } }), null, '1H trend does not back it');
  assert.equal(higherAgainst({ ...args, base: [...base, c(6, 0.7015, 0.7019)], t: 7 * 900 }), null, 'tapped since');
});

test('imbalance play: an unfilled opposite push right ahead; a swing in between cancels it', () => {
  const push = [0.705, 0.7044, 0.7038, 0.7032, 0.7026, 0.702].slice(0, -1).map((o, k) => c(k + 1, o, o - 0.0006));
  const candles = [...push, c(6, 0.702, 0.7012), c(7, 0.7012, 0.7004), c(8, 0.7004, 0.7001), nwBull(9, 0.7, 0.7006)];
  const z = imbalanceAhead({ dir: 'bull', candles, swings: [], tf: 900 });
  assert.deepEqual(z, { from: 0.7001, to: 0.705 }, 'the whole unfilled drop above the entry');
  const blocker = { type: 'high', time: 7 * 900, level: 0.701, wick: 0.7012, confirmedAt: 8 * 900 };
  assert.equal(imbalanceAhead({ dir: 'bull', candles, swings: [blocker], tf: 900 }), null);
});

const level = {
  candleOpen: utc('2026-11-04T14:15:00Z'), id: 'x', num: 9, pair: 'OANDA:AUDUSD', tf: 900, dir: 'bull', level: 0.7, deadline: utc('2026-11-04T16:30:00Z'),
  setup: { entry: 0.7, stop: 0.699, tp: 0.701, warnings: [] }, internal: { dir: 'bull', count: 2 }, external: { dir: 'bear', count: 1 }, session: 'New York', upgrades: [],
  leg: { pos: 0.2, price: 0.7004 }, htfAgainst: { tf: 3600, dir: 'bear', level: 0.702, time: utc('2026-11-04T13:00:00Z') }, nyOpen: true,
};

test("alerts show Bard's checks: pre-entry, the 1H no-wick against, and NY open on non-A+ setups only", () => {
  const t = formatEvent({ kind: 'formed', level });
  for (const s of ['📍 Pre-entry: the no-wick sits near the start of its leg (20%). Bard enters early here, around 0.7004',
    '⚠️ Untapped 1H bearish no-wick against this trade (Wed 15:00 candle, at 0.702): it can play out first', '⚠️ New York open: Bard only takes A+ setups here'])
    assert.ok(t.includes(s), `missing: ${s}\n${t}`);
  const clean = formatEvent({ kind: 'formed', level: { ...level, external: { dir: 'bull', count: 1 }, leg: { pos: 0.6, price: 0.7 }, htfAgainst: null } });
  assert.ok(!clean.includes('📍') && !clean.includes('⚠️'), 'A+ at NY open, high in the leg, nothing against');
});

test('imbalance play alert shows the zone and its R; /why explains it and skipped pullbacks', () => {
  const imb = { ...level, imb: { from: 0.7012, to: 0.7016 }, setup: { ...level.setup, tp: 0.7016 }, internal: { dir: 'bull', count: 1 } };
  const t = formatEvent({ kind: 'formed', level: imb });
  assert.ok(t.includes('· 🌀 IMBALANCE PLAY') && t.includes('Unfilled imbalance right ahead at 0.7012–0.7016: TP at its far edge (0.7016, 1.6R)') && t.includes('imbalance play, 1 BOS'), t);
  const s = freshState();
  s.levels.push({ ...imb, num: 9 }, { ...level, num: undefined, id: 'p', shadow: true, skipReason: "pullback (not Bard's rule)", candleOpen: utc('2026-11-04T09:00:00Z'),
    internal: { dir: 'bear', count: 1 }, external: { dir: 'bull', count: 2 }, status: 'expired' });
  assert.match(whyText(s, '#9'), /Imbalance play: 1 15m BOS against the 4H/);
  const p = whyText(s, 'AUDUSD 11:00');
  assert.ok(p.includes("Not alerted: a pullback, which isn't Bard's rule.") && p.includes('Bard needs both to agree, so only GER40 alerts these'), p);
});

test("Bard's doji: both wicks bigger than the body", () => {
  const wicky = { open: 0.7, close: 0.7002, high: 0.7006, low: 0.6996 }; // body 2, wicks 4 and 4 (pips)
  const oneSided = { open: 0.7, close: 0.7002, high: 0.7003, low: 0.6990 };
  config.dojiRule = 'wicks';
  assert.equal(isDoji(wicky), true);
  assert.equal(isDoji(oneSided), false);
  config.dojiRule = 'pct';
  assert.equal(isDoji(wicky), false, 'the current rule needs the body under 10% of the range');
});
