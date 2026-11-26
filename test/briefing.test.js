import test from 'node:test';
import assert from 'node:assert/strict';
import { briefingText, dayBias, currencyTheme, personalTips } from '../src/reports.js';
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

test('currency theme: a currency every forex pair agrees on (4H), never from indices or crypto', () => {
  const t = (name, fx, d) => ({ name, fx, h1: b(d), h4: b(d) });
  const trends = [t('AUDUSD', ['AUD', 'USD'], 'bear'), t('GBPUSD', ['GBP', 'USD'], 'bear'), t('AUDJPY', ['AUD', 'JPY'], 'bear'), t('BTCUSD', null, 'bull')];
  assert.deepEqual(currencyTheme(trends), ['AUD weak (AUDUSD, AUDJPY)', 'USD strong (AUDUSD, GBPUSD)']);
  trends[2].h4 = b('bull');
  assert.deepEqual(currencyTheme(trends), ['USD strong (AUDUSD, GBPUSD)'], 'AUD split: no theme');
  const text = briefingText({ date: '2026-11-26', now, trends, news: { ok: true, events: [{ t: utc('2026-11-26T13:00:00Z'), country: 'USD', title: 'Bank Holiday', holiday: true }] } });
  assert.ok(text.includes('💱 <b>Theme</b> (4H): USD strong (AUDUSD, GBPUSD). Trades on these pairs are one bet.'), text);
  assert.ok(text.includes('🏖 USD bank holiday: thin liquidity') && !text.includes('None for your pairs'), text);
});

test('personal tips: weak and strong groups (5+ trades), a losing streak, rotated into the briefing', () => {
  const l = (i, session, status, extra = {}) => ({ pair: 'OANDA:AUDJPY', dir: 'bull', session, status, formedClose: now - 3600 * i,
    internal: { dir: 'bull', count: 1 }, external: { dir: 'bear', count: 1 }, ...extra });
  const levels = [
    ...[1, 2, 3, 4, 5].map((i) => l(i, 'New York', i === 1 ? 'won' : 'lost')),
    ...[6, 7, 8, 9, 10].map((i) => l(i, 'Asia', 'won', { external: { dir: 'bull', count: 1 } })),
    l(11, 'London', 'won', { shadow: true }), l(12, 'London', 'won', { formedClose: now - 20 * 86400 }),
    l(13, 'Asia', 'lost', { reported: 'SL', reportedAt: 2 }), l(14, 'Asia', 'won', { reported: 'SL', reportedAt: 1 }),
  ];
  const tips = personalTips(levels, now);
  for (const s of ['New York session alerts went 1W/4L. Be extra picky', 'Asia session alerts went 5W/2L', 'A+ alerts went 5W/0L. That', 'Your last two reported trades were losses'])
    assert.ok(tips.some((t) => t.includes(s)), `missing: ${s}\n${tips.join('\n')}`);
  assert.ok(!tips.some((t) => t.includes('London')), 'skipped and old alerts never count');
  const text = briefingText({ date: '2026-11-26', now, trends: [], news: { ok: true, events: [] }, tips });
  assert.match(text.split('\n')[2], /^📒 /);
  assert.ok(!briefingText({ date: '2026-11-26', now, trends: [], news: { ok: true, events: [] } }).includes('📒'));
});

test('briefing tips rotate daily and stay short', () => {
  assert.ok(QUOTES.length >= 40);
  assert.notEqual(quoteFor('2026-11-26'), quoteFor('2026-11-27'));
  assert.ok(QUOTES.every((q) => q.text.split(' ').length <= 20));
});
