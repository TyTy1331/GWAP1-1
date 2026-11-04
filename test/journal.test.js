import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncJournal } from '../src/journal.js';
import { newLevel, advanceMinute } from '../src/lifecycle.js';
import { processPair } from '../src/run.js';
import { recapText } from '../src/reports.js';
import { freshState } from '../src/state.js';
import { seq, zigzag, utc } from './helpers/candles.js';

const PAIR = 'OANDA:AUDUSD';
const setup = { entry: 0.7, stop: 0.6989, tp: 0.7011, altStop: null, riskPips: 11, warnings: ['Large stop: 25 pips', 'Conflicting bearish no-wick at 0.7005, near TP'] };
const trend = { dir: 'bull', count: 1 };
const level = (open, extra = {}) => Object.assign(newLevel({ pair: PAIR, tf: 900, candle: { time: open, open: 0.7, high: 0.7008, low: 0.7, close: 0.7006 }, dir: 'bull', setup: { ...setup }, internal: trend, external: trend, session: 'London', num: 5 }), extra);
const m = (t, low, high) => ({ time: t, open: (low + high) / 2, high, low, close: (low + high) / 2 });
const rows = (file) => readFileSync(file, 'utf8').trim().split('\n');

test('a skipped no-wick is tracked silently: no alerts, result kept out of the recap', () => {
  const nw = utc('2026-11-04T00:45:00Z'); // outside session
  const rowsUp = zigzag([0.700, 0.702, 0.701, 0.703, 0.702, 0.704, 0.7032]);
  const m15 = seq(nw - rowsUp.length * 900, 900, rowsUp);
  m15.push({ time: nw, open: 0.7032, high: 0.7041, low: 0.7032, close: 0.7039 });
  const h4 = seq(nw - rowsUp.length * 14400, 14400, rowsUp);
  const state = freshState();
  state.pairs[PAIR] = { last1m: nw + 900, last15: nw };
  const { events } = processPair(state, PAIR, { m1: [], m15, m30: [], h1: [], h4 }, nw + 960, { ok: true, events: [] });
  assert.equal(events.length, 0);
  const l = state.levels[0];
  assert.equal(l.shadow, true);
  assert.equal(l.skipReason, 'outside session');
  assert.equal(l.num, undefined, 'skipped setups use no trade number');
  // it still taps and resolves, silently
  assert.deepEqual(advanceMinute(state, PAIR, m(nw + 1200, 0.7031, 0.7034), []), []);
  assert.deepEqual(advanceMinute(state, PAIR, m(nw + 1260, 0.7034, 0.71), []), []);
  assert.equal(l.status, 'won');
  assert.equal(state.results[0].shadow, true);
  assert.ok(recapText(state.results.filter((r) => !r.shadow), 0).includes('No tapped trades'));
});

test('journal writes one row per finished setup and updates it in place when you report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nowick-j-'));
  const state = freshState();
  const l = level(utc('2026-11-04T09:00:00Z'));
  state.levels.push(l);
  assert.equal(syncJournal(state, dir), 0, 'live setups are not written yet');
  Object.assign(l, { status: 'won', tapTime: utc('2026-11-04T09:20:00Z'), tapIndex: 1, resultTime: utc('2026-11-04T09:40:00Z') });
  assert.equal(syncJournal(state, dir), 1);
  assert.equal(syncJournal(state, dir), 0, 'unchanged rows are not rewritten');
  Object.assign(l, { reported: 'SL', reportedAt: utc('2026-11-04T10:00:00Z') });
  syncJournal(state, dir);
  const r = rows(join(dir, '2026-11.csv'));
  assert.equal(r.length, 2, 'header + one row');
  assert.ok(r[0].startsWith('id,number,alerted,skip_reason,pair'));
  assert.ok(r[1].includes(',#05,yes,,AUDUSD,15m,BUY,2026-11-04T09:00:00Z,'));
  assert.ok(r[1].includes('"Large stop: 25 pips; Conflicting bearish no-wick at 0.7005, near TP"'), 'commas are quoted');
  assert.ok(r[1].includes(',TP,,2026-11-04T09:40:00Z,SL,2026-11-04T10:00:00Z'));
});

test('journal splits by formation month and keeps old months', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nowick-j-'));
  const state = freshState();
  state.levels.push(level(utc('2026-10-30T09:00:00Z'), { status: 'expired' }), level(utc('2026-11-02T09:00:00Z'), { status: 'nosetup', setup: null, shadow: true, skipReason: 'no opposite swing for a stop' }));
  syncJournal(state, dir);
  assert.deepEqual(readdirSync(dir).sort(), ['2026-10.csv', '2026-11.csv']);
  assert.ok(rows(join(dir, '2026-11.csv'))[1].includes(',no,no opposite swing for a stop,'));
  state.levels = []; // pruned from memory after 14 days…
  syncJournal(state, dir);
  assert.equal(rows(join(dir, '2026-10.csv')).length, 2, '…but the journal keeps them');
});
