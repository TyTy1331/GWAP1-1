import test from 'node:test';
import assert from 'node:assert/strict';
import { newLevel, advanceMinute, breakEvenSignals } from '../src/lifecycle.js';
import { formatEvent } from '../src/telegram.js';
import { journalRow } from '../src/journal.js';
import { freshState } from '../src/state.js';
import { utc } from './helpers/candles.js';

const PAIR = 'OANDA:AUDUSD';
const T0 = utc('2026-11-04T10:00:00Z');
const m = (t, low, high) => ({ time: t, open: (low + high) / 2, high, low, close: (low + high) / 2 });
const bearNoWick = (t, open, close) => ({ time: t, open, high: open, low: close - 0.0001, close });

// Long at 0.7000, stop 0.6989, TP 0.7011, tapped at 10:20.
function openLong() {
  const state = freshState();
  const setup = { entry: 0.7, stop: 0.6989, tp: 0.7011, altStop: null, riskPips: 11, warnings: [] };
  const l = newLevel({ pair: PAIR, tf: 900, candle: { time: T0, open: 0.7, high: 0.7008, low: 0.7, close: 0.7006 }, dir: 'bull', setup, internal: { dir: 'bull', count: 1 }, external: { dir: 'bull', count: 1 }, session: 'London', num: 5 });
  state.levels.push(l);
  advanceMinute(state, PAIR, m(T0 + 1200, 0.69995, 0.7003), []);
  assert.equal(l.status, 'tracking');
  return { state, l };
}

test('opposite no-wick while in profit: alert to move the stop to break-even', () => {
  const { state, l } = openLong();
  const ev = breakEvenSignals(state, PAIR, bearNoWick(T0 + 1800, 0.7008, 0.7004), 'bear', T0 + 2700);
  assert.equal(ev.length, 1);
  assert.equal(l.beSignal.mode, 'stop');
  assert.match(formatEvent(ev[0]), /#05 AUDUSD 15m BUY<\/b> · no-wick against you[\s\S]*move your stop to break-even \(0\.7\)/);
  // price comes back to entry → managed result BE; later the plain 1:1 tracking is stopped out
  advanceMinute(state, PAIR, m(T0 + 2800, 0.6999, 0.7002), []);
  assert.equal(l.managedResult, 'BE');
  advanceMinute(state, PAIR, m(T0 + 2900, 0.6985, 0.6995), []);
  assert.equal(l.status, 'lost');
  assert.equal(l.managedResult, 'BE', 'following the rule turned a loss into break-even');
});

test('opposite no-wick while in drawdown: alert to move TP to break-even', () => {
  const { state, l } = openLong();
  const ev = breakEvenSignals(state, PAIR, bearNoWick(T0 + 1800, 0.6998, 0.6993), 'bear', T0 + 2700);
  assert.equal(l.beSignal.mode, 'tp');
  assert.match(formatEvent(ev[0]), /In drawdown → move your TP to break-even/);
  advanceMinute(state, PAIR, m(T0 + 2800, 0.6996, 0.7001), []); // back to entry
  assert.equal(l.managedResult, 'BE');
  advanceMinute(state, PAIR, m(T0 + 2900, 0.7005, 0.7012), []);
  assert.equal(l.status, 'won');
  assert.equal(l.managedResult, 'BE');
});

test('no signal: managed result equals the plain result', () => {
  const { state, l } = openLong();
  advanceMinute(state, PAIR, m(T0 + 1300, 0.7005, 0.7012), []);
  assert.equal(l.status, 'won');
  assert.equal(l.managedResult, 'TP');
});

test('only opposite no-wicks after the tap count, and only once', () => {
  const { state, l } = openLong();
  assert.deepEqual(breakEvenSignals(state, PAIR, { time: T0 + 1800, open: 0.7004, high: 0.7009, low: 0.7004, close: 0.7008 }, 'bull', T0 + 2700), [], 'same direction');
  assert.deepEqual(breakEvenSignals(state, PAIR, bearNoWick(T0 + 900, 0.7008, 0.7004), 'bear', T0 + 1800), [], 'candle opened before the tap');
  assert.equal(breakEvenSignals(state, PAIR, bearNoWick(T0 + 1800, 0.7008, 0.7004), 'bear', T0 + 2700).length, 1);
  assert.equal(breakEvenSignals(state, PAIR, bearNoWick(T0 + 2700, 0.7008, 0.7004), 'bear', T0 + 3600).length, 0, 'second one is silent');
  assert.equal(l.beSignal.time, T0 + 2700);
});

test('silently tracked (skipped) setups get the signal in the journal but no alert', () => {
  const { state, l } = openLong();
  l.shadow = true;
  assert.deepEqual(breakEvenSignals(state, PAIR, bearNoWick(T0 + 1800, 0.7008, 0.7004), 'bear', T0 + 2700), []);
  advanceMinute(state, PAIR, m(T0 + 2800, 0.6999, 0.7002), []);
  assert.ok(journalRow(l).includes(',stop to BE,BE'));
});
