import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sessionAt, marketOpen, latestMarketClose, addMarketBars, marketBarIndex, marketMinutesBetween,
  parseNews, newsMute, upcomingNews, refreshNews } from '../src/filters.js';
import { utc } from './helpers/candles.js';

const fixture = readFileSync(new URL('./fixtures/ff_calendar.json', import.meta.url), 'utf8');
const news = parseNews(fixture);

test('northern winter sessions in SAST: 05:00–15:00 and 17:00–22:00', () => {
  assert.equal(sessionAt(utc('2026-11-04T04:00:00Z')), 'Late Asia');   // 06:00 SAST
  assert.equal(sessionAt(utc('2026-11-04T09:00:00Z')), 'London');      // 11:00 SAST
  assert.equal(sessionAt(utc('2026-11-04T14:00:00Z')), null);          // 16:00 SAST, NY open
  assert.equal(sessionAt(utc('2026-11-04T16:00:00Z')), 'London');      // 18:00 SAST
  assert.equal(sessionAt(utc('2026-11-04T19:00:00Z')), 'New York');    // 21:00 SAST
  assert.equal(sessionAt(utc('2026-11-04T20:30:00Z')), null);          // 22:30 SAST, late NY
  assert.equal(sessionAt(utc('2026-11-04T01:00:00Z')), null);          // 03:00 SAST, early Asia
});

test('northern summer: New York exclusions shift an hour earlier in SAST', () => {
  assert.equal(sessionAt(utc('2026-07-01T13:00:00Z')), null);      // 15:00 SAST = 09:00 NY (EDT), NY open
  assert.equal(sessionAt(utc('2026-07-01T14:30:00Z')), 'London');  // 16:30 SAST = 10:30 NY, allowed
});

test('market week: closed Saturday, opens Sunday 17:00 New York', () => {
  assert.equal(marketOpen(utc('2026-11-07T12:00:00Z')), false);           // Saturday
  assert.equal(marketOpen(utc('2026-11-08T21:59:00Z')), false);           // Sun 16:59 NY
  assert.equal(marketOpen(utc('2026-11-08T22:00:00Z')), true);            // Sun 17:00 NY
  assert.equal(marketOpen(utc('2026-11-06T21:59:00Z')), true);            // Fri 16:59 NY
  assert.equal(marketOpen(utc('2026-11-06T22:00:00Z')), false);           // Fri 17:00 NY
  assert.equal(latestMarketClose(utc('2026-11-07T12:00:00Z')), utc('2026-11-06T22:00:00Z'));
});

test('9 market candles from a Friday 16:00 NY 1H close land on Sunday evening', () => {
  const close = utc('2026-11-06T22:00:00Z'); // Fri 17:00 NY
  const deadline = addMarketBars(close, 9, 3600);
  assert.equal(deadline, utc('2026-11-09T07:00:00Z')); // Sun 17:00 NY + 9h
  assert.equal(marketBarIndex(close, utc('2026-11-08T22:30:00Z'), 3600), 1);
});

test('tap index counts candles after the no-wick close (AE7: 10:31 on a 10:15 close is 2/9)', () => {
  assert.equal(marketBarIndex(utc('2026-11-04T10:15:00Z'), utc('2026-11-04T10:31:00Z'), 900), 2);
  assert.equal(marketBarIndex(utc('2026-11-04T10:15:00Z'), utc('2026-11-04T10:15:00Z'), 900), 1);
});

test('market minutes skip the weekend', () => {
  assert.equal(marketMinutesBetween(utc('2026-11-06T21:50:00Z'), utc('2026-11-08T22:10:00Z')), 20);
});

test('AE4: USD CPI at 13:30 UTC mutes 13:15, not 14:05', () => {
  assert.equal(newsMute(news, 'OANDA:GBPUSD', utc('2026-11-04T13:15:00Z')), true);
  assert.equal(newsMute(news, 'OANDA:GBPUSD', utc('2026-11-04T14:05:00Z')), false);
});

test('GBP news mutes a London GBPUSD setup on its own (no session overlap)', () => {
  assert.equal(newsMute(news, 'OANDA:GBPUSD', utc('2026-11-04T05:45:00Z')), true);
  assert.equal(newsMute(news, 'OANDA:AUDUSD', utc('2026-11-04T05:45:00Z')), false, 'GBP news does not mute AUDUSD');
});

test('AUD news does not mute GBPUSD; low impact and holidays are ignored', () => {
  assert.equal(newsMute(news, 'OANDA:GBPUSD', utc('2026-11-05T00:30:00Z')), false);
  assert.equal(newsMute(news, 'OANDA:AUDUSD', utc('2026-11-05T00:30:00Z')), true);
  assert.equal(news.length, 3);
});

test('upcoming news: within 2 hours only', () => {
  assert.equal(upcomingNews(news, 'OANDA:GBPUSD', utc('2026-11-04T12:00:00Z')).length, 1); // CPI in 90 min
  assert.equal(upcomingNews(news, 'OANDA:GBPUSD', utc('2026-11-04T10:30:00Z')).length, 0); // CPI in 3h
});

test('news feed failure keeps the cache and flags unavailable', async () => {
  const cache = { ok: true, fetchedAt: 0, events: news };
  const bad = async () => ({ ok: true, text: async () => '<html>' });
  const r = await refreshNews(cache, 7 * 3600, bad);
  assert.equal(r.ok, false);
  assert.equal(r.events.length, 3);
  const fresh = await refreshNews(cache, 3600, bad);
  assert.equal(fresh, cache, 'not refreshed within 6 hours');
});
