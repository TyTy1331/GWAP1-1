import test from 'node:test';
import assert from 'node:assert/strict';
import { briefingText, dayBias } from '../src/reports.js';
import { QUOTES, quoteFor } from '../src/quotes.js';
import { utc } from './helpers/candles.js';

const b = (dir, count = 1) => ({ dir, count });
const now = utc('2026-11-26T03:00:00Z'); // Thu 05:00 SAST

test("morning briefing: greeting, a tip or quote, each pair's 1H/4H bias and today's news only", () => {
  const text = briefingText({
    date: '2026-11-26', now, dataAgeSec: 120,
    trends: [{ name: 'AUDUSD', ext: 14400, h1: b('bull', 2), h4: b('bull') }, { name: 'GER40', ext: 3600, h1: b('bear'), h4: b('bull') }, { name: 'BTCUSD', error: true }],
    news: { ok: true, events: [
      { t: utc('2026-11-26T13:30:00Z'), country: 'USD', title: 'GDP' },
      { t: utc('2026-11-27T13:30:00Z'), country: 'USD', title: 'Tomorrow' },
      { t: utc('2026-11-26T09:00:00Z'), country: 'CAD', title: 'Not mine' },
    ] },
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '👋 <b>Hello, sir.</b>');
  assert.match(lines[1], /^(💭|🧠) <i>/);
  for (const s of ['🟢 <b>AUDUSD</b> bullish · favour buys', '1H bull ×2 · 4H bull ×1', '🟡 <b>GER40</b> mixed · 1H bearish, 4H bullish: sells follow the 1H',
    '⚠️ <b>BTCUSD</b> data unavailable', '• 15:30 USD GDP', 'latest data 2 min old']) assert.ok(text.includes(s), `missing: ${s}\n${text}`);
  assert.ok(!text.includes('Tomorrow') && !text.includes('Not mine'));
});

test('briefing bias: unclear external trend, no news, news feed down', () => {
  assert.deepEqual(dayBias({ ext: 14400, h1: b('bull'), h4: b(null, 0) }), ['⚪', 'unclear · wait for 4H structure']);
  assert.ok(briefingText({ date: '2026-11-26', now, trends: [], news: { ok: true, events: [] } }).includes('None for your pairs.'));
  assert.ok(briefingText({ date: '2026-11-26', now, trends: [], news: { ok: false, events: [] } }).includes('News calendar unavailable'));
});

test('briefing tips rotate daily and stay short', () => {
  assert.ok(QUOTES.length >= 40);
  assert.notEqual(quoteFor('2026-11-26'), quoteFor('2026-11-27'));
  assert.ok(QUOTES.every((q) => q.text.split(' ').length <= 20));
});
