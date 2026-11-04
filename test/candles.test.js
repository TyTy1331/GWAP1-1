import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, isFresh, credentialsFromEnv, fetchCandles, FeedError } from '../src/candles.js';
import { config } from '../src/config.js';

test('drops the still-forming candle, keeps one closed exactly now; ms → s', () => {
  const now = 1793817120;
  const out = normalize([{ time: (now - 120) * 1000, open: 1, high: 1, low: 1, close: 1 }, { time: now - 60, open: 1, high: 1, low: 1, close: 1 }, { time: now, open: 1, high: 1, low: 1, close: 1 }], 60, now);
  assert.deepEqual(out.map((c) => c.time), [now - 120, now - 60]);
});

test('freshness: 3 minutes old is fresh, 12 is stale', () => {
  const now = 100000;
  assert.equal(isFresh([{ time: now - 240 }], now), true);
  assert.equal(isFresh([{ time: now - 780 }], now), false);
  assert.equal(isFresh([], now), false);
});

test('credentials need both secrets', () => {
  const warnings = [];
  assert.deepEqual(credentialsFromEnv({ TV_SESSION: 'a', TV_SIGNATURE: 'b' }), { session: 'a', signature: 'b' });
  assert.equal(credentialsFromEnv({ TV_SESSION: 'a' }, (w) => warnings.push(w)), undefined);
  assert.equal(warnings.length, 1);
});

test('empty or failing feed raises FeedError without credentials in the message', async () => {
  const opts = { pair: config.pairs[0], tf: 60, count: 5, now: 1e9, credentials: { session: 'SECRET' } };
  await assert.rejects(fetchCandles({ ...opts, getCandles: async () => [] }), FeedError);
  await assert.rejects(fetchCandles({ ...opts, getCandles: async () => { throw new Error('boom'); } }),
    (e) => e instanceof FeedError && !e.message.includes('SECRET'));
});

test('config lists both pairs and valid zones', () => {
  assert.deepEqual(config.pairs, ['OANDA:AUDUSD', 'OANDA:GBPUSD']);
  for (const w of [...config.sessions.allowed, ...config.sessions.excluded]) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: w.zone }));
});
