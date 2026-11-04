import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processPair, runOnce } from '../src/run.js';
import { freshState, saveState } from '../src/state.js';
import { newLevel } from '../src/lifecycle.js';
import { seq, zigzag, utc } from './helpers/candles.js';

const PAIR = 'OANDA:AUDUSD';
const noNews = { ok: true, events: [] };
const UP = [0.700, 0.702, 0.701, 0.703, 0.702, 0.704, 0.7032];

// Rising 15m and 4H history ending with a bullish no-wick opening at `nwOpen`.
function trendData(nwOpen) {
  const rows = zigzag(UP);
  const m15 = seq(nwOpen - rows.length * 900, 900, rows);
  m15.push({ time: nwOpen, open: 0.7032, high: 0.7041, low: 0.7032, close: 0.7039 });
  const h4 = seq(nwOpen - rows.length * 14400, 14400, rows);
  return { m1: [], m15, m30: [], h1: [], h4 };
}

test('valid bullish no-wick in London forms a level and an alert', () => {
  const nw = utc('2026-11-04T09:00:00Z');
  const state = freshState();
  state.pairs[PAIR] = { last1m: nw + 900, last15: nw };
  const { events } = processPair(state, PAIR, trendData(nw), nw + 960, noNews);
  assert.deepEqual(events.map((e) => e.kind), ['formed']);
  assert.equal(state.levels[0].level, 0.7032);
  assert.equal(state.pairs[PAIR].last15, nw + 900);
});

test('the same no-wick outside a session is skipped with a reason', () => {
  const nw = utc('2026-11-04T00:45:00Z'); // 02:45 SAST
  const state = freshState();
  state.pairs[PAIR] = { last1m: nw + 900, last15: nw };
  const { events, skipped } = processPair(state, PAIR, trendData(nw), nw + 960, noNews);
  assert.equal(events.length, 0);
  assert.equal(skipped[0].reason, 'outside session');
});

function levelAt(open) {
  const state = freshState();
  const candle = { time: open, open: 0.7, high: 0.7008, low: 0.7, close: 0.7006 };
  const setup = { entry: 0.7, stop: 0.6989, tp: 0.7011, altStop: null, riskPips: 11, warnings: [] };
  state.levels.push(newLevel({ pair: PAIR, tf: 900, candle, dir: 'bull', setup, internal: { dir: 'bull', count: 1 }, external: { dir: 'bull', count: 1 }, session: 'London' }));
  state.pairs[PAIR] = { last1m: open + 900, last15: open + 900 };
  return state;
}
const higher = (open) => ({ time: open, open: 0.7, high: 0.7015, low: 0.7, close: 0.7012 });
const quiet15 = (t) => ({ time: t, open: 0.7006, high: 0.7009, low: 0.7004, close: 0.7007 });

test('late run: tap at 09:20 is replayed before the 09:30 30m close, so no upgrade', () => {
  const open = utc('2026-11-04T09:00:00Z');
  const state = levelAt(open);
  const m1 = [{ time: utc('2026-11-04T09:20:00Z'), open: 0.7003, high: 0.7004, low: 0.7, close: 0.7002 }];
  const data = { m1, m15: [quiet15(open + 900)], m30: [higher(open)], h1: [], h4: [] };
  const { events } = processPair(state, PAIR, data, utc('2026-11-04T09:44:00Z'), noNews);
  assert.deepEqual(events.map((e) => e.kind), ['tap']);
  assert.equal(state.levels[0].tf, 900);
});

test('untapped level upgrades at the 30m close, then again at the 1H close', () => {
  const open = utc('2026-11-04T09:00:00Z');
  const state = levelAt(open);
  const data = { m1: [], m15: [quiet15(open + 900), quiet15(open + 1800), quiet15(open + 2700)], m30: [higher(open)], h1: [higher(open)], h4: [] };
  const { events } = processPair(state, PAIR, data, utc('2026-11-04T10:01:00Z'), noNews);
  assert.deepEqual(events.map((e) => e.id), [`${state.levels[0].id}:up1800`, `${state.levels[0].id}:up3600`]);
  assert.equal(state.levels[0].tf, 3600);
});

// ---- runOnce with fakes ----

function fakeCandles(now) {
  return async ({ timeframe, count }) => {
    const tf = { 1: 60, 15: 900, 30: 1800, 60: 3600, 240: 14400 }[timeframe];
    const end = Math.floor(now / tf) * tf;
    return Array.from({ length: count }, (_, i) => {
      const t = end - (count - i) * tf, base = 0.7 + ((i % 7) - 3) * 0.0002;
      return { time: t, open: base, high: base + 0.0003, low: base - 0.0003, close: base + 0.0001 };
    });
  };
}
const okNews = async () => ({ ok: true, text: async () => '[]' });

function setupRun(now, mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'nowick-run-'));
  const STATE_PATH = join(dir, 'state.json');
  if (mutate) { const s = freshState(); mutate(s); saveState(STATE_PATH, s); }
  return { STATE_PATH, read: () => JSON.parse(readFileSync(STATE_PATH, 'utf8')) };
}

test('fresh state: first run sends nothing old and starts from now', async () => {
  const now = utc('2026-11-04T09:07:30Z');
  const { STATE_PATH, read } = setupRun(now);
  const logs = [];
  const code = await runOnce({ now, env: { STATE_PATH, DRY_RUN: '1' }, getCandles: fakeCandles(now), fetchFn: okNews, log: (l) => logs.push(l) });
  assert.equal(code, 0);
  const s = read();
  assert.equal(s.pairs[PAIR].last1m, utc('2026-11-04T09:07:00Z'));
  assert.equal(s.levels.length, 0);
  assert.ok(!logs.some((l) => l.startsWith('--- ') && !l.includes('checkin')), logs.join('\n'));
});

test('Telegram 5xx: state (sent IDs, progress) is written before the failing exit', async () => {
  const now = utc('2026-11-04T09:07:30Z');
  const { STATE_PATH, read } = setupRun(now, (s) => { s.outbox.push({ id: 'one', text: 'a' }, { id: 'two', text: 'b' }); s.lastCheckin = '2026-11-04'; });
  let n = 0;
  const fetchFn = async (url) => {
    if (!String(url).includes('telegram')) return okNews();
    n++;
    return { ok: n === 1, status: n === 1 ? 200 : 502, json: async () => ({}) };
  };
  const code = await runOnce({ now, env: { STATE_PATH, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' }, getCandles: fakeCandles(now), fetchFn, log: () => {} });
  assert.equal(code, 1);
  const s = read();
  assert.ok(s.sent.one);
  assert.deepEqual(s.outbox.map((m) => m.id), ['two']);
});

test('weekend: catches up to the Friday close, then sends the recap once', async () => {
  const close = utc('2026-11-06T22:00:00Z');
  const now = close + 600; // Fri 17:10 NY
  const { STATE_PATH, read } = setupRun(now, (s) => {
    for (const p of ['OANDA:AUDUSD', 'OANDA:GBPUSD']) s.pairs[p] = { last1m: close - 600, last15: close - 900 };
    s.results.push({ id: 'r', pair: PAIR, tf: 900, dir: 'bull', outcome: 'won', closed: close - 3600 });
  });
  const logs = [];
  const run = () => runOnce({ now, env: { STATE_PATH, DRY_RUN: '1' }, getCandles: fakeCandles(close), fetchFn: okNews, log: (l) => logs.push(l) });
  assert.equal(await run(), 0);
  assert.equal(read().pairs[PAIR].last1m, close);
  assert.ok(logs.some((l) => l.includes('Weekly recap') && l.includes('1W / 0L')), logs.join('\n'));
  logs.length = 0;
  await run();
  assert.ok(!logs.some((l) => l.includes('Weekly recap')));
});
