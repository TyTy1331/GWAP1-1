import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEvent, sendMessage, deliver, enqueue, esc, TelegramError } from '../src/telegram.js';
import { freshState } from '../src/state.js';
import { utc } from './helpers/candles.js';

const level = {
  id: 'OANDA:GBPUSD:1:bull', pair: 'OANDA:GBPUSD', tf: 900, dir: 'bull', level: 1.3457, deadline: utc('2026-11-04T12:30:00Z'),
  setup: { entry: 1.3457, stop: 1.3446, altStop: 1.345, tp: 1.3468, riskPips: 11, warnings: ['Unfilled void against the trade at 1.344–1.345'] },
  internal: { dir: 'bull', count: 2 }, external: { dir: 'bull', count: 1 }, session: 'London',
};

test('formation message carries the full checklist in SAST', () => {
  const text = formatEvent({ kind: 'formed', level }, { upcoming: [{ country: 'GBP', title: 'GDP <prelim>', t: utc('2026-11-04T11:00:00Z') }], newsUnavailable: true });
  for (const s of ['GBPUSD 15m BUY', 'Entry: <b>1.3457', 'Stop: 1.3446', 'alt 1.345', 'TP: 1.3468', '11 pips',
    '15m trend: bullish (2 BOS)', '4H: bullish (1 BOS) (aligned)', 'Session: London', '14:30 SAST', '⚠️ Unfilled void',
    'GDP &lt;prelim&gt;', 'News check unavailable']) assert.ok(text.includes(s), `missing: ${s}\n${text}`);
});

test('no warnings means no warning lines', () => {
  const text = formatEvent({ kind: 'formed', level: { ...level, setup: { ...level.setup, warnings: [] } } });
  assert.ok(!text.includes('⚠️'));
});

test('escape covers &, < and >', () => assert.equal(esc('a&b<c>'), 'a&amp;b&lt;c&gt;'));

const res = (status, body = {}) => ({ ok: status === 200, status, json: async () => body });
const noWait = async () => {};

test('429 then 200: sent once', async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push(init); return calls.length === 1 ? res(429, { parameters: { retry_after: 1 } }) : res(200); };
  assert.equal(await sendMessage('hi', { token: 't', chatId: 'c', fetchFn, wait: noWait }), 'sent');
  assert.equal(calls.length, 2);
});

test('500 then 500: throws without recording', async () => {
  const state = freshState();
  enqueue(state, 'a', 'hello');
  await assert.rejects(deliver(state, { token: 't', chatId: 'c', fetchFn: async () => res(500), now: 1, wait: noWait }), TelegramError);
  assert.equal(state.sent.a, undefined);
  assert.equal(state.outbox.length, 1, 'stays queued for the next run');
});

test('400 parse error is permanent: marked failed, notice sent, never retried', async () => {
  const state = freshState();
  enqueue(state, 'bad', '<b>broken');
  const bodies = [];
  const fetchFn = async (url, init) => { bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? res(400, { description: "can't parse entities" }) : res(200); };
  await deliver(state, { token: 't', chatId: 'c', fetchFn, now: 5, wait: noWait });
  assert.equal(state.failed.bad, 5);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].parse_mode, undefined, 'notice is plain text');
  enqueue(state, 'bad', '<b>broken');
  assert.equal(state.outbox.length, 0);
});

test('already-sent IDs are never queued again', () => {
  const state = freshState();
  state.sent.x = 1;
  enqueue(state, 'x', 'again');
  enqueue(state, 'y', 'new');
  enqueue(state, 'y', 'dup');
  assert.deepEqual(state.outbox.map((m) => m.id), ['y']);
});

test('errors never include the token-bearing URL', async () => {
  const fetchFn = async () => { throw new TypeError('fetch failed https://api.telegram.org/botSECRET/sendMessage'); };
  await assert.rejects(sendMessage('hi', { token: 'SECRET', chatId: 'c', fetchFn, wait: noWait }), (e) => !e.message.includes('SECRET'));
});
