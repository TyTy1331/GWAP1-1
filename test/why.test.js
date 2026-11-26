import test from 'node:test';
import assert from 'node:assert/strict';
import { whyText } from '../src/why.js';
import { freshState } from '../src/state.js';
import { readInbox } from '../src/inbox.js';
import { utc } from './helpers/candles.js';

const at = utc('2026-11-26T06:45:00Z'); // Thu 08:45 SAST
const ger = { id: 'g', num: 175, pair: 'FOREXCOM:GER40', tf: 300, dir: 'bull', candleOpen: at, session: 'London', upgrades: [], status: 'won',
  tapTime: at + 600, tapIndex: 1, resultTime: at + 3000, internal: { dir: 'bear', count: 1 }, external: { dir: 'bull', count: 1 } };
const skipped = { id: 'a', pair: 'OANDA:AUDJPY', tf: 900, dir: 'bull', candleOpen: utc('2026-11-26T11:15:00Z'), session: 'London', upgrades: [], status: 'expired',
  shadow: true, skipReason: 'trend (15m bull×1, 4H bear)', internal: { dir: 'bull', count: 1 }, external: { dir: 'bear', count: 3 } };
const state = () => { const s = freshState(); s.levels.push(ger, skipped); return s; };

test('/why #175 explains the alert: trends, the rule that let it through, and the outcome', () => {
  const t = whyText(state(), '#175');
  for (const s of ['#175 GER40 5m BUY</b> · Thu 08:45 candle', '✅ Alerted', '5m bearish (1 BOS) · 1H bullish (1 BOS)',
    'Pullback: the 1H agrees and the 5m has only 1 BOS against', 'Tapped Thu 08:55 (candle 1/9), then TP ✅ Thu 09:35']) assert.ok(t.includes(s), `missing: ${s}\n${t}`);
});

test('/why PAIR HH:MM explains a skipped no-wick by its candle open time (SAST)', () => {
  const t = whyText(state(), 'audjpy 13:15');
  for (const s of ['⏭ Not alerted: the trend rules were not met.', "Against the 4H: needs 2 15m BOS in the trade's direction, it had 1.",
    'No tap within 9 candles: expired.']) assert.ok(t.includes(s), `missing: ${s}\n${t}`);
});

test('/why: off-grid times, missing candles, unknown pairs and a bare /why get a helpful answer', () => {
  assert.match(whyText(state(), 'AUDJPY 13:20'), /open every 15 minutes \(e\.g\. 13:15\)/);
  assert.match(whyText(state(), 'AUDJPY 13:30'), /No no-wick on AUDJPY 15m at 13:30/);
  assert.match(whyText(state(), 'EURUSD 13:15'), /I don't watch EURUSD/);
  assert.match(whyText(state(), '#9'), /No trade #09/);
  assert.match(whyText(state(), ''), /\/why #175/);
});

test('/why is answered from Telegram', async () => {
  let calls = 0;
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: calls++ ? [] : [{ update_id: 1, message: { chat: { id: 5 }, text: '/why@GWAPSIGNALS_BOT #175' } }] }) });
  const [r] = await readInbox(state(), { token: 't', chatId: '5', now: at, fetchFn });
  assert.match(r.text, /#175 GER40 5m BUY/);
});
