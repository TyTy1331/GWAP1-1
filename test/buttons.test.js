import test from 'node:test';
import assert from 'node:assert/strict';
import { buttons, enqueue, deliver } from '../src/telegram.js';
import { applyReport, readInbox } from '../src/inbox.js';
import { recapText } from '../src/reports.js';
import { freshState } from '../src/state.js';

const level = { id: 'x', num: 7, pair: 'OANDA:GBPUSD', tf: 900, dir: 'bull', status: 'won', formedClose: 1000 };
const lvl = (num, extra = {}) => ({ ...level, num, ...extra });
const ok = (result = []) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

test('report buttons go under alerted formation and result messages only, and are sent as reply_markup', async () => {
  const kb = buttons({ kind: 'formed', level });
  assert.deepEqual(kb.inline_keyboard.flat().map((b) => b.callback_data), ['r:7:TP', 'r:7:SL', 'r:7:BE', 'r:7:TAKEN', 'r:7:INVALID']);
  assert.ok(buttons({ kind: 'result', level }));
  for (const e of [{ kind: 'tap', level }, { kind: 'formed', level: { ...level, shadow: true } }, { kind: 'formed', level: { ...level, num: undefined } }]) {
    assert.equal(buttons(e), undefined);
  }
  const state = freshState();
  enqueue(state, 'a', 'hi', kb);
  const bodies = [];
  await deliver(state, { token: 't', chatId: 'c', fetchFn: async (u, init) => { bodies.push(JSON.parse(init.body)); return ok(); }, now: 1 });
  assert.deepEqual(bodies[0].reply_markup, kb);
});

// Behaves like Telegram: only returns updates at or after the requested offset.
const updates = (all) => async (url) => ok(all.filter((u) => u.update_id >= Number(new URL(url).searchParams.get('offset'))));
const press = (update_id, chatId, data) => ({ update_id, callback_query: { id: 'q', data, message: { chat: { id: chatId } } } });

test('a button press counts like a typed report; presses from other chats are ignored', async () => {
  const s = freshState();
  s.levels.push(lvl(5));
  const replies = await readInbox(s, { token: 't', chatId: '42', now: 9, fetchFn: updates([press(1, 111, 'r:5:SL'), press(2, 42, 'r:5:TP'), press(3, 42, 'junk')]) });
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /#05 GBPUSD 15m BUY marked TP/);
  assert.equal(s.levels[0].reported, 'TP');
  assert.equal(s.tgOffset, 3);
});

test('"Took it" marks a trade taken; the bot result counts until you report the close', () => {
  const s = freshState();
  s.levels.push(lvl(5), lvl(6, { status: 'tracking' }));
  assert.match(applyReport(s, { num: 5, outcome: 'TAKEN' }, 1), /marked as taken/);
  assert.match(recapText([], 1, [s.levels[0]]), /1 TP \/ 0 SL \(100%\)/, 'bot won → counts as TP');
  assert.match(applyReport(s, { num: 5, outcome: 'SL' }, 2), /marked SL/, 'a first close, not a change');
  assert.match(applyReport(s, { num: 5, outcome: 'TAKEN' }, 3), /already marked SL/);
  applyReport(s, { num: 6, outcome: 'TAKEN' }, 4);
  assert.match(recapText([], 1, [s.levels[1]]), /0 TP \/ 0 SL\n❔ #06/, 'still running → no result yet');
});
