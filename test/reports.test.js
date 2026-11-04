import test from 'node:test';
import assert from 'node:assert/strict';
import { recapStats, recapText, checkinDue } from '../src/reports.js';
import { freshState } from '../src/state.js';
import { utc } from './helpers/candles.js';

const r = (outcome, pair = 'OANDA:AUDUSD', tf = 900) => ({ outcome, pair, tf });

test('recap math: 7W 3L 1 unknown 2 muted → 70%, others listed apart', () => {
  const results = [...Array(7).fill(r('won')), ...Array(3).fill(r('lost')), r('unknown'), r('muted'), r('muted')];
  const all = recapStats(results).find((g) => g.key === 'All');
  assert.deepEqual(all, { key: 'All', won: 7, lost: 3, unknown: 1, muted: 2, rate: 70 });
  const text = recapText(results, 12);
  assert.ok(text.includes('7W / 3L (70%) · 1 unknown · 2 muted by news'));
  assert.ok(text.includes('AUDUSD 15m'));
});

test('empty week says so', () => assert.ok(recapText([], 0).includes('No tapped trades')));

test('check-in due once per SAST day from 05:00', () => {
  const s = freshState();
  assert.equal(checkinDue(s, utc('2026-11-04T02:30:00Z')), null); // 04:30 SAST
  const d = checkinDue(s, utc('2026-11-04T03:05:00Z'));
  assert.equal(d, '2026-11-04');
  s.lastCheckin = d;
  assert.equal(checkinDue(s, utc('2026-11-04T10:00:00Z')), null);
});
