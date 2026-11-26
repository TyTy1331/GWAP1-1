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
const near = (a, b) => Math.abs(a - b) < 1e-9;

// Long at 0.7000 off a swing at 0.6990: real stop 2.5 pips below (0.69875), TP 0.70125. Previous candle low 0.6995.
// Tests: 1/2/3 pips of room → stops 0.6989 / 0.6988 / 0.6987; previous candle → 0.69925; TP 1:1.5 → 0.701875.
function openLong() {
  const state = freshState();
  const setup = { entry: 0.7, stop: 0.69875, tp: 0.70125, altStop: 0.6995, structure: 0.699, riskPips: 12.5, warnings: [] };
  const l = newLevel({ pair: PAIR, tf: 900, candle: { time: T0, open: 0.7, high: 0.7008, low: 0.7, close: 0.7006 }, dir: 'bull', setup, internal: { dir: 'bull', count: 1 }, external: { dir: 'bull', count: 1 }, session: 'London', num: 5 });
  state.levels.push(l);
  advanceMinute(state, PAIR, m(T0 + 1200, 0.69995, 0.7003), []);
  return { state, l };
}
const tests = (state) => Object.fromEntries(state.tests.map((t) => [t.test, t.r]));

test('rule tests: stops with 1, 2 and 3 pips of room and at the previous candle, all 1:1, plus TP at 1:1.5', () => {
  const { state, l } = openLong();
  assert.ok(near(l.tests.buf1.stop, 0.6989) && near(l.tests.buf2.stop, 0.6988) && near(l.tests.buf3.stop, 0.6987));
  assert.ok(near(l.tests.prev.stop, 0.69925) && near(l.tests.prev.tp, 0.70075) && near(l.tests.tp15.tp, 0.701875));
  advanceMinute(state, PAIR, m(T0 + 1300, 0.7005, 0.7013), []);
  assert.equal(l.status, 'won');
  assert.deepEqual(tests(state), { buf1: 1, buf2: 1, buf3: 1, prev: 1 });
  advanceMinute(state, PAIR, m(T0 + 1400, 0.701, 0.7019), []);
  assert.equal(tests(state).tp15, 1.5, 'keeps running after the real trade');
  assert.ok(journalRow(l).includes(',1.5,1,1,1,1,'));
});

test('more room can survive what stops a tighter stop', () => {
  const { state, l } = openLong();
  advanceMinute(state, PAIR, m(T0 + 1300, 0.69885, 0.6995), []);
  assert.equal(l.status, 'tracking', 'the real 2.5-pip stop survives');
  advanceMinute(state, PAIR, m(T0 + 1400, 0.7005, 0.7013), []);
  assert.deepEqual(tests(state), { prev: -1, buf1: -1, buf2: 1, buf3: 1 });
  assert.equal(l.status, 'won');
});

test('setups from before the change (no structure) assume 1 pip of room; skipped setups get no tests', () => {
  const state = freshState();
  const l = newLevel({ pair: PAIR, tf: 900, candle: { time: T0, open: 0.7, high: 0.7008, low: 0.7, close: 0.7006 }, dir: 'bull', setup: { stop: 0.6989, tp: 0.7011, altStop: null, warnings: [] }, internal: {}, external: {}, session: 'London', num: 1 });
  const s = newLevel({ pair: PAIR, tf: 900, candle: { time: T0 + 1, open: 0.7, high: 0.7008, low: 0.7, close: 0.7006 }, dir: 'bull', setup: { stop: 0.6989, tp: 0.7011, warnings: [] }, internal: {}, external: {}, session: 'London' });
  s.shadow = true;
  state.levels.push(l, s);
  advanceMinute(state, PAIR, m(T0 + 1200, 0.69995, 0.7003), []);
  assert.ok(near(l.tests.buf1.stop, 0.6989) && near(l.tests.buf3.stop, 0.6987) && !l.tests.prev);
  assert.equal(s.tests, undefined);
});

test('the recap scoreboard compares each rule on the same trades and shows skipped pullbacks', () => {
  const now = utc('2026-11-27T22:00:00Z');
  const s = freshState();
  const r = (id, outcome, extra) => ({ id, outcome, closed: now - 86400, aplus: false, pullback: false, managed: outcome === 'won' ? 'TP' : 'SL', ...extra });
  s.results.push(r('a', 'won', { aplus: true }), r('b', 'lost', { pullback: true, managed: 'BE' }), r('c', 'won', { rr: 1.6 }), r('old', 'won', { closed: now - 40 * 86400 }), r('x', 'won', { shadow: true }),
    r('p1', 'lost', { shadow: true, skip: "pullback (not Bard's rule)" }), r('p2', 'lost', { shadow: true, skip: "pullback (not Bard's rule)" }), r('p3', 'won', { shadow: true, skip: "pullback (not Bard's rule)" }));
  s.tests = [{ id: 'a', test: 'tp15', r: 1.5 }, { id: 'b', test: 'tp15', r: -1 }, { id: 'x', test: 'tp15', r: 1.5 }, { id: 'a', test: 'buf3', r: 1 }];
  const t = testsText(s, now);
  for (const line of ['Now, exact 1:1: 3 trades · 2W/1L · +1.6R', '⬆️ TP at 1:1.5: +0.5R vs 0R (2 trades)', '➖ Stop with 3 pips of room: +1R vs +1R (1 trades)',
    '⬆️ Following the BE rule: +2R vs +1.6R (3 trades)', '⬇️ Only A+ alerts: +1R from 1 of 3 trades', '⬆️ Without pullback alerts: +2.6R from 2 of 3 trades',
    '⏭ Skipped pullbacks would have made -1R (1W/2L)']) assert.ok(t.includes(line), `missing: ${line}\n${t}`);
  assert.equal(testsText(freshState(), now), '');
});
