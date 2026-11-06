import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReports, applyReport, readInbox, replyReport } from '../src/inbox.js';
import { recapText } from '../src/reports.js';
import { formatEvent } from '../src/telegram.js';
import { freshState } from '../src/state.js';

const lvl = (num, extra = {}) => ({ num, pair: 'OANDA:AUDUSD', tf: 900, dir: 'bear', formedClose: 1000 + num, status: 'won', ...extra });

test('parses #05TP, #5 sl and several reports in one message; ignores the rest', () => {
  assert.deepEqual(parseReports('#05TP'), [{ num: 5, outcome: 'TP' }]);
  assert.deepEqual(parseReports('closed #5 sl, and #12 TP'), [{ num: 5, outcome: 'SL' }, { num: 12, outcome: 'TP' }]);
  assert.deepEqual(parseReports('05TP tp #TP #05 TPX'), []);
  assert.deepEqual(parseReports('#7BE and #8 b/e'), [{ num: 7, outcome: 'BE' }, { num: 8, outcome: 'BE' }]);
});

test('report marks the trade; a second report corrects it; unknown numbers say so', () => {
  const s = freshState();
  s.levels.push(lvl(5));
  assert.match(applyReport(s, { num: 5, outcome: 'TP' }, 1), /#05 AUDUSD 15m SELL marked TP/);
  assert.equal(s.levels[0].reported, 'TP');
  assert.match(applyReport(s, { num: 5, outcome: 'SL' }, 2), /changed to SL/);
  assert.match(applyReport(s, { num: 9, outcome: 'TP' }, 3), /No trade #09/);
  assert.match(applyReport(s, { num: 5, outcome: 'BE' }, 4), /changed to B\/E/);
});

// Behaves like Telegram: only returns updates at or after the requested offset.
const updates = (all) => async (url) => {
  const offset = Number(new URL(url).searchParams.get('offset'));
  return { ok: true, status: 200, json: async () => ({ ok: true, result: all.filter((u) => u.update_id >= offset) }) };
};
const msg = (update_id, chatId, text) => ({ update_id, message: { chat: { id: chatId }, text } });

test('only the configured chat can report; offset advances past every update', async () => {
  const s = freshState();
  s.levels.push(lvl(5));
  const replies = await readInbox(s, { token: 't', chatId: '873516785', now: 9, fetchFn: updates([msg(10, 111, '#05SL'), msg(11, 873516785, '#05TP')]) });
  assert.equal(replies.length, 1);
  assert.equal(s.levels[0].reported, 'TP');
  assert.equal(s.tgOffset, 11);
});

test('being added to a group tells the configured chat that group\'s ID', async () => {
  const s = freshState();
  const joined = { update_id: 3, my_chat_member: { chat: { id: -1001234, title: 'GWAP TEAM' }, new_chat_member: { status: 'member' } } };
  const [r] = await readInbox(s, { token: 't', chatId: '873516785', now: 9, fetchFn: updates([joined]) });
  assert.match(r.text, /GWAP TEAM.*-1001234/);
});

test('recap lists your reported trades by number, plus bot tracking', () => {
  const text = recapText([{ outcome: 'won', pair: 'OANDA:AUDUSD', tf: 900 }], 3, [lvl(7, { reported: 'SL' }), lvl(5, { reported: 'TP' })]);
  assert.ok(text.includes('<b>Your trades</b>: 1 TP / 1 SL (50%)'));
  const be = recapText([], 3, [lvl(7, { reported: 'SL' }), lvl(5, { reported: 'TP' }), lvl(6, { reported: 'BE' })]);
  assert.ok(be.includes('<b>Your trades</b>: 1 TP / 1 SL / 1 B/E (50%)'), be);
  assert.ok(be.includes('➖ #06'), be);
  assert.ok(text.indexOf('✅ #05') < text.indexOf('❌ #07'));
  assert.ok(text.includes('Bot tracking'));
});

test('alerts carry the trade number, without a reply hint', () => {
  const level = { ...lvl(5), level: 0.7, candleOpen: 1000, deadline: 2000, session: 'London', internal: { dir: 'bear', count: 1 }, external: { dir: 'bear', count: 1 },
    setup: { entry: 0.7, stop: 0.7011, altStop: null, tp: 0.6989, riskPips: 11, warnings: [] }, tapIndex: 2 };
  const formed = formatEvent({ kind: 'formed', level });
  assert.ok(formed.includes('#05 AUDUSD 15m SELL'));
  assert.ok(!formed.includes('reply'));
  assert.ok(formatEvent({ kind: 'tap', level, time: 1500 }).includes('#05 AUDUSD'));
});

test('a bare TP sent as a reply to an alert reports that alert number', async () => {
  const alert = { text: '🔴 #05 AUDUSD 15m SELL\nBearish no-wick · Fri 09:00 candle' };
  assert.equal(replyReport({ text: 'tp', reply_to_message: alert }), '#05tp');
  assert.equal(replyReport({ text: 'B/E!', reply_to_message: alert }), '#05B/E');
  assert.equal(replyReport({ text: 'tp', reply_to_message: { text: 'no number here' } }), null);
  assert.equal(replyReport({ text: 'tp hit nicely', reply_to_message: alert }), null);
  assert.equal(replyReport({ text: 'TP' }), null);
  const s = freshState();
  s.levels.push(lvl(5));
  const reply = { update_id: 1, message: { chat: { id: 873516785 }, text: 'TP', reply_to_message: alert } };
  const [r] = await readInbox(s, { token: 't', chatId: '873516785', now: 9, fetchFn: updates([reply]) });
  assert.match(r.text, /#05 AUDUSD 15m SELL marked TP/);
});

test('reads past 100 messages in one run', async () => {
  const s = freshState();
  s.levels.push(lvl(5));
  const many = Array.from({ length: 250 }, (_, i) => msg(i + 1, 873516785, i === 230 ? '#05TP' : 'chat'));
  const pages = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: many.filter((u) => u.update_id >= offset).slice(0, 100) }) };
  };
  const replies = await readInbox(s, { token: 't', chatId: '873516785', now: 9, fetchFn: pages });
  assert.equal(replies.length, 1);
  assert.equal(s.tgOffset, 250);
});
