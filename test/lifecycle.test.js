import test from 'node:test';
import assert from 'node:assert/strict';
import { newLevel, advanceMinute, markDataGap, upgrade } from '../src/lifecycle.js';
import { freshState } from '../src/state.js';
import { utc } from './helpers/candles.js';
import { formatEvent } from '../src/telegram.js';

const PAIR = 'OANDA:AUDUSD';
const setup = { entry: 0.7, stop: 0.6989, tp: 0.7011, altStop: null, riskPips: 11, warnings: [] };
const trend = { dir: 'bull', count: 1 };

function stateWithLevel(open = utc('2026-11-04T10:00:00Z'), tf = 900) {
  const state = freshState();
  const candle = { time: open, open: 0.7, high: 0.7008, low: 0.7, close: 0.7006 };
  state.levels.push(newLevel({ pair: PAIR, tf, candle, dir: 'bull', setup: { ...setup }, internal: trend, external: trend, session: 'London' }));
  return state;
}
const m = (t, low, high) => ({ time: t, open: (low + high) / 2, high, low, close: (low + high) / 2 });

test('AE7: touch at 10:31 on the 10:00 level is tapped 2/9, tracking from 10:31', () => {
  const s = stateWithLevel();
  const ev = advanceMinute(s, PAIR, m(utc('2026-11-04T10:31:00Z'), 0.69995, 0.7003), []);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'tap');
  assert.equal(s.levels[0].tapIndex, 2);
  assert.equal(s.levels[0].tapTime, utc('2026-11-04T10:31:00Z'));
});

test('AE3: first touch in the 10th candle after formation expires instead', () => {
  const s = stateWithLevel();
  const tenth = utc('2026-11-04T10:15:00Z') + 9 * 900; // start of candle 10
  const ev = advanceMinute(s, PAIR, m(tenth, 0.6999, 0.7003), []);
  assert.deepEqual(ev, []);
  assert.equal(s.levels[0].status, 'expired');
});

test('minutes before the level closes are ignored', () => {
  const s = stateWithLevel();
  assert.deepEqual(advanceMinute(s, PAIR, m(utc('2026-11-04T10:10:00Z'), 0.6995, 0.7005), []), []);
  assert.equal(s.levels[0].status, 'active');
});

test('tap minute that also reaches the stop is a loss', () => {
  const s = stateWithLevel();
  const ev = advanceMinute(s, PAIR, m(utc('2026-11-04T10:20:00Z'), 0.6985, 0.7002), []);
  assert.deepEqual(ev.map((e) => e.kind), ['tap', 'result']);
  assert.equal(ev[1].outcome, 'lost');
});

test('tap minute that reaches TP is not a win yet; TP counts from the next minute', () => {
  const s = stateWithLevel();
  const t = utc('2026-11-04T10:20:00Z');
  assert.deepEqual(advanceMinute(s, PAIR, m(t, 0.69995, 0.7012), []).map((e) => e.kind), ['tap']);
  const ev = advanceMinute(s, PAIR, m(t + 60, 0.7005, 0.7012), []);
  assert.equal(ev[0].outcome, 'won');
  assert.equal(s.results[0].outcome, 'won');
});

test('a later minute that hits both stop and TP is a loss', () => {
  const s = stateWithLevel();
  const t = utc('2026-11-04T10:20:00Z');
  advanceMinute(s, PAIR, m(t, 0.69995, 0.7002), []);
  assert.equal(advanceMinute(s, PAIR, m(t + 60, 0.6985, 0.7015), [])[0].outcome, 'lost');
});

test('tap during news: no alerts, outcome recorded as muted', () => {
  const s = stateWithLevel();
  const t = utc('2026-11-04T10:20:00Z');
  const news = [{ t: t + 600, country: 'USD', title: 'x' }];
  assert.deepEqual(advanceMinute(s, PAIR, m(t, 0.69995, 0.7002), news), []);
  assert.deepEqual(advanceMinute(s, PAIR, m(t + 60, 0.7005, 0.7012), news), []);
  assert.equal(s.results[0].outcome, 'muted');
});

test('tap in the no-trade zone (22:10 SAST) is tracked silently and kept out of the results', () => {
  const s = stateWithLevel(utc('2026-11-04T19:15:00Z')); // formed 21:30 SAST
  const t = utc('2026-11-04T20:10:00Z');
  assert.deepEqual(advanceMinute(s, PAIR, m(t, 0.69995, 0.7002), []), []);
  assert.equal(s.levels[0].status, 'tracking');
  assert.equal(s.levels[0].invalid, 'tapped in no-trade hours');
  assert.deepEqual(advanceMinute(s, PAIR, m(t + 60, 0.7005, 0.7012), []), []);
  assert.equal(s.levels[0].status, 'won');
  assert.equal(s.results[0].shadow, true);
});

test('near miss: within 2 pips without a tap, then TP → invalid alert, later tap stays silent', () => {
  const s = stateWithLevel();
  const t = utc('2026-11-04T10:20:00Z');
  assert.deepEqual(advanceMinute(s, PAIR, m(t, 0.7004, 0.7012), []), [], 'TP without coming close changes nothing');
  assert.deepEqual(advanceMinute(s, PAIR, m(t + 60, 0.70015, 0.7005), []), [], 'near miss alone is quiet');
  const ev = advanceMinute(s, PAIR, m(t + 120, 0.7006, 0.7011), []);
  assert.deepEqual(ev.map((e) => e.kind), ['invalid']);
  assert.equal(s.levels[0].invalid, 'near miss, then ran to TP');
  assert.deepEqual(advanceMinute(s, PAIR, m(t + 180, 0.6999, 0.7003), []), []);
  assert.equal(s.levels[0].status, 'tracking');
});

test('prop-firm rule: a running trade is closed 5 min before midnight SAST', () => {
  const s = stateWithLevel(utc('2026-11-04T19:00:00Z')); // 21:00 SAST
  advanceMinute(s, PAIR, m(utc('2026-11-04T19:20:00Z'), 0.69995, 0.7002), []);
  assert.deepEqual(advanceMinute(s, PAIR, m(utc('2026-11-04T21:54:00Z'), 0.7003, 0.7005), []), []);
  const ev = advanceMinute(s, PAIR, m(utc('2026-11-04T21:55:00Z'), 0.7003, 0.7008), []); // 23:55 SAST
  assert.equal(ev[0].outcome, 'closed');
  assert.equal(s.levels[0].status, 'closed');
  assert.equal(s.levels[0].closedR, 0.5);
  assert.deepEqual([s.results[0].outcome, s.results[0].r], ['closed', 0.5]);
  assert.match(formatEvent(ev[0]), /closed for the day \(\+0\.5R\)/);
});

test('Friday 1H level tapped Sunday after the open, within 9 market candles', () => {
  const s = stateWithLevel(utc('2026-11-06T21:00:00Z'), 3600); // Fri 16:00 NY 1H
  const ev = advanceMinute(s, PAIR, m(utc('2026-11-09T03:30:00Z'), 0.69995, 0.7002), []); // Mon 05:30 SAST
  assert.equal(ev[0].kind, 'tap');
  assert.equal(s.levels[0].tapIndex, 6);
});

test('replaying the same minute twice gives no new events', () => {
  const s = stateWithLevel();
  const c = m(utc('2026-11-04T10:20:00Z'), 0.69995, 0.7002);
  advanceMinute(s, PAIR, c, []);
  assert.deepEqual(advanceMinute(s, PAIR, c, []), []);
});

test('data gap marks live levels unknown and emits one gap event', () => {
  const s = stateWithLevel();
  const ev = markDataGap(s, PAIR, 100, 200);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].count, 1);
  assert.equal(s.levels[0].status, 'unknown');
});

test('upgrade re-bases the window to the higher timeframe', () => {
  const s = stateWithLevel(utc('2026-11-04T09:00:00Z'));
  const l = s.levels[0];
  upgrade(l, 1800, { time: utc('2026-11-04T09:00:00Z') }, { ...setup, stop: 0.6985 });
  assert.equal(l.tf, 1800);
  assert.equal(l.windowStart, utc('2026-11-04T09:30:00Z'));
  assert.equal(l.deadline, utc('2026-11-04T09:30:00Z') + 9 * 1800);
  assert.equal(l.setup.stop, 0.6985);
});
