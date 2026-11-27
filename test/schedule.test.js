import test from 'node:test';
import assert from 'node:assert/strict';
import { quiet, due } from '../src/schedule.js';
import { utc } from './helpers/candles.js';

const empty = { levels: [] };
const night = utc('2026-11-25T21:00:00Z'); // Wed 23:00 SAST, no-trade zone

test('quiet hours: forex weekend or outside every session, unless a forex/GER40 trade is still open', () => {
  assert.equal(quiet(empty, utc('2026-11-28T08:00:00Z')), true, 'Saturday');
  assert.equal(quiet(empty, night), true, 'weekday night');
  assert.equal(quiet(empty, utc('2026-11-25T10:00:00Z')), false, 'Wed 12:00 SAST');
  assert.equal(quiet({ levels: [{ pair: 'OANDA:AUDUSD', status: 'tracking' }] }, night), false, 'a forex trade is still open');
  assert.equal(quiet({ levels: [{ pair: 'CRYPTO:BTCUSD', status: 'tracking' }] }, night), true, 'an open BTC trade is fine hourly');
});

test('hourly in quiet hours from hh:01; a failed run is retried on the next trigger; always due otherwise', () => {
  assert.equal(due(empty, night + 30), false, 'hh:00:30: the 1H candle data may not be in yet');
  assert.equal(due({ ...empty, lastOk: night - 3600 + 120 }, night + 120), true, 'first trigger of the hour');
  assert.equal(due({ ...empty, lastOk: night + 120 }, night + 420), false, 'this hour already checked');
  assert.equal(due({ ...empty, lastOk: night - 3600 + 120 }, night + 420), true, 'the hh:02 run failed: retry at hh:07');
  assert.equal(due({ ...empty, lastOk: utc('2026-11-25T10:01:00Z') }, utc('2026-11-25T10:02:00Z')), true, 'trading hours: every trigger');
});
