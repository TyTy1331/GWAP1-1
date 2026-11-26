import test from 'node:test';
import assert from 'node:assert/strict';
import { newLevel, advanceMinute } from '../src/lifecycle.js';
import { testsText } from '../src/reports.js';
import { journalRow } from '../src/journal.js';
import { freshState } from '../src/state.js';
import { utc } from './helpers/candles.js';

const PAIR = 'OANDA:AUDUSD';
const T0 = utc('2026-11-04T10:00:00Z');
const m = (t, low, high) => ({ time: t, open: (low + high) / 2, high, low, close: (low + high) / 2 });

// Long at 0.7000, stop 0.6989 (11 pips), TP 0.7011, tapped at 10:20. Tests: 1:1.5 TP 0.70165; wider stop 0.6988 → TP 0.7012.
function openLong() {
  const state = freshState();
  const setup = { entry: 0.7, stop: 0.6989, tp: 0.7011, altStop: null, riskPips: 11, warnings: [] };
  const l = newLevel({ pair: PAIR, tf: 900, candle: { time: T0, open: 0.7, high: 0.7008, low: 0.7, close: 0.7006 }, dir: 'bull', setup, internal: { dir: 'bull', count: 1 }, external: { dir: 'bull', count: 1 }, session: 'London', num: 5 });
  state.levels.push(l);
  advanceMinute(state, PAIR, m(T0 + 1200, 0.69995, 0.7003), []);
  return { state, l };
}
const tests = (state) => Object.fromEntries(state.tests.map((t) => [t.test, t.r]));

test('rule tests keep running after the real trade: 1:1.5 TP and a 1-pip wider stop', () => {
  const { state, l } = openLong();
  assert.ok(Math.abs(l.tests.tp15.tp - 0.70165) < 1e-9 && Math.abs(l.tests.buf2.stop - 0.6988) < 1e-9);
  advanceMinute(state, PAIR, m(T0 + 1300, 0.7005, 0.7012), []);
  assert.equal(l.status, 'won');
  assert.deepEqual(tests(state), { buf2: 1 });
  advanceMinute(state, PAIR, m(T0 + 1400, 0.701, 0.7017), []);
  assert.deepEqual(tests(state), { buf2: 1, tp15: 1.5 });
  assert.ok(journalRow(l).endsWith(',1.5,1'));
});

test('a wider stop can survive a stop-out of the real trade', () => {
  const { state, l } = openLong();
  advanceMinute(state, PAIR, m(T0 + 1300, 0.69885, 0.6995), []);
  assert.equal(l.status, 'lost');
  advanceMinute(state, PAIR, m(T0 + 1400, 0.7005, 0.7012), []);
  assert.deepEqual(tests(state), { tp15: -1, buf2: 1 });
});

test('skipped (silent) setups get no rule tests', () => {
  const state = freshState();
  const l = newLevel({ pair: PAIR, tf: 900, candle: { time: T0, open: 0.7, high: 0.7008, low: 0.7, close: 0.7006 }, dir: 'bull', setup: { stop: 0.6989, tp: 0.7011, warnings: [] }, internal: {}, external: {}, session: 'London' });
  l.shadow = true;
  state.levels.push(l);
  advanceMinute(state, PAIR, m(T0 + 1200, 0.69995, 0.7003), []);
  assert.equal(l.tests, undefined);
});

test('the recap scoreboard compares each rule on the same trades', () => {
  const now = utc('2026-11-27T22:00:00Z');
  const s = freshState();
  const r = (id, outcome, extra) => ({ id, outcome, closed: now - 86400, aplus: false, pullback: false, managed: outcome === 'won' ? 'TP' : 'SL', ...extra });
  s.results.push(r('a', 'won', { aplus: true }), r('b', 'lost', { pullback: true, managed: 'BE' }), r('c', 'won'), r('old', 'won', { closed: now - 40 * 86400 }), r('x', 'won', { shadow: true }));
  s.tests = [{ id: 'a', test: 'tp15', r: 1.5 }, { id: 'b', test: 'tp15', r: -1 }, { id: 'x', test: 'tp15', r: 1.5 }];
  const t = testsText(s, now);
  for (const line of ['Now, exact 1:1: 3 trades · 2W/1L · +1R', '⬆️ TP at 1:1.5: +0.5R vs 0R (2 trades)', '⬆️ Following the BE rule: +2R vs +1R (3 trades)',
    '➖ Only A+ alerts: +1R from 1 of 3 trades', '⬆️ Without the pullback rule: +2R from 2 of 3 trades']) assert.ok(t.includes(line), `missing: ${line}\n${t}`);
  assert.equal(testsText(freshState(), now), '');
});
