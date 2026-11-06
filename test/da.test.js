import test from 'node:test';
import assert from 'node:assert/strict';
import { volumeProfile, valleys, validate, spaced, applyDA, daPlayZone, prevDayOpen } from '../src/da.js';
import { processPair } from '../src/run.js';
import { freshState } from '../src/state.js';
import { formatEvent } from '../src/telegram.js';
import { journalRow } from '../src/journal.js';
import { recapText } from '../src/reports.js';
import { seq, zigzag, utc } from './helpers/candles.js';

const PAIR = 'OANDA:AUDUSD';
const ZONE = { lo: 0.7011, hi: 0.7013 };
const bar = (o, h, l, c) => [o, h, l, c];
const doji = (mid, lo, hi, volume = 1000) => ({ open: mid, high: hi, low: lo, close: mid, volume });

test('previous trading day opens at 17:00 New York, skipping the weekend', () => {
  assert.equal(prevDayOpen(utc('2026-11-04T09:00:00Z')), utc('2026-11-02T22:00:00Z')); // Wed → Mon 17:00 NY
  assert.equal(prevDayOpen(utc('2026-11-09T09:00:00Z')), utc('2026-11-05T22:00:00Z')); // Mon → Thu 17:00 NY
});

test('profile valley: a thin row between two busy clusters is the one candidate', () => {
  const candles = [...Array(10)].flatMap(() => [doji(0.7005, 0.7, 0.701), doji(0.7019, 0.7014, 0.7024)]);
  assert.deepEqual(valleys(volumeProfile(candles)), [0.7012]);
});

// Three dips into the zone, each bouncing 12+ pips within a candle.
const bounce = [bar(0.703, 0.7031, 0.7019, 0.702), bar(0.702, 0.7021, 0.7011, 0.7014), bar(0.7014, 0.7026, 0.7013, 0.7025), bar(0.7025, 0.7031, 0.7024, 0.703)];
const c30 = (rows) => seq(0, 1800, rows);

test('reactions: touched 3 times with 12-pip moves → kept; touched once → dropped', () => {
  assert.equal(validate(ZONE, c30([...bounce, ...bounce, ...bounce])).reactions, 3);
  assert.equal(validate(ZONE, c30(bounce)), null);
});

test('consolidation: 4 closes inside the zone → dropped', () => {
  const inside = [...Array(4)].map(() => bar(0.7012, 0.7013, 0.7011, 0.7012));
  assert.equal(validate(ZONE, c30([...bounce, ...bounce, ...inside])), null);
});

test('fake-out 2 pips beyond widens the zone; one beyond 6 pips drops it', () => {
  const fake = (close) => [bar(0.702, 0.7021, close, close), bar(close, 0.7021, close, 0.702)];
  const z = validate(ZONE, c30([...bounce, ...fake(0.7009), ...bounce]));
  assert.deepEqual([z.lo, z.hi], [0.7009, 0.7013]);
  assert.equal(validate(ZONE, c30([...bounce, ...fake(0.7003), ...bounce])), null);
});

test('spacing: two zones 8 pips apart → the one with more reactions is kept', () => {
  assert.deepEqual(spaced([{ lo: 0.7011, hi: 0.7013, reactions: 2 }, { lo: 0.7019, hi: 0.7021, reactions: 4 }]).map((z) => z.reactions), [4]);
});

test('warnings: entry inside a DA, selling low in the range, TP past a DA, DA guarding the stop', () => {
  const das = [{ lo: 0.7, hi: 0.7002 }, { lo: 0.7019, hi: 0.7021 }, { lo: 0.708, hi: 0.7082 }];
  const sell = applyDA({ entry: 0.7012, stop: 0.703, tp: 0.6994, warnings: [] }, 'bear', das);
  assert.deepEqual(sell.warnings, ['TP is beyond a DA at 0.7002 — consider TP just before it']);
  assert.equal(sell.da.rangePos, 58);
  assert.deepEqual(sell.notes, ['A DA between entry and stop protects it (0.7019–0.7021)']);
  const low = applyDA({ entry: 0.7004, stop: 0.7015, tp: 0.6993, warnings: [] }, 'bear', [das[0], das[2]]);
  assert.ok(low.warnings.includes('Selling near the bottom of the range (4%)'), low.warnings.join('|'));
  const inside = applyDA({ entry: 0.702, stop: 0.701, tp: 0.703, warnings: [] }, 'bull', das);
  assert.ok(inside.warnings.includes('Entry is inside a decision area (0.7019–0.7021)'));
  assert.equal(inside.da.inDA, true);
});

test('DA play zone: the DA behind entry must be touched and held', () => {
  const touch = seq(0, 900, [bar(0.703, 0.7031, 0.7012, 0.7015), bar(0.7015, 0.7025, 0.7015, 0.7024)]);
  assert.deepEqual(daPlayZone('bull', touch, [ZONE]), ZONE);
  const broke = seq(0, 900, [bar(0.703, 0.7031, 0.7005, 0.7008), bar(0.7015, 0.7025, 0.7015, 0.7024)]);
  assert.equal(daPlayZone('bull', broke, [ZONE]), null);
  const far = seq(0, 900, [bar(0.703, 0.7031, 0.702, 0.7022), bar(0.7022, 0.7025, 0.7022, 0.7024)]);
  assert.equal(daPlayZone('bull', far, [ZONE]), null);
});

// 15m: bearish structure, a dip into the DA at 0.7011–0.7013, then one bullish BOS and a bullish no-wick.
// 4H is bearish, so the normal rule needs 2 BOS and skips it.
function daPlayData(nw, withDA) {
  const legs = zigzag([0.705, 0.704, 0.7045, 0.703, 0.7036, 0.7013, 0.704]);
  const t0 = nw - legs.length * 900;
  const profile = [...Array(20)].flatMap((_, i) => [{ time: t0 - (40 - 2 * i) * 900, ...doji(0.7, 0.699, 0.701) },
    { time: t0 - (39 - 2 * i) * 900, ...doji(0.7027, 0.7014, 0.704) }]);
  const m15 = [...profile, ...seq(t0, 900, legs), { time: nw, open: 0.7038, high: 0.7044, low: 0.7038, close: 0.7043 }];
  const h4rows = zigzag([0.71, 0.708, 0.709, 0.707, 0.708, 0.706, 0.7065]);
  const h4 = seq(nw - h4rows.length * 14400, 14400, h4rows);
  const m30 = withDA ? seq(t0 - 12 * 1800 - 40 * 900, 1800, [...bounce, ...bounce, ...bounce]) : [];
  return { m1: [], m15, m30, h1: [], h4 };
}

test('DA play: counter-trend no-wick after holding a DA → 🧪 alert with the stop beyond the DA', () => {
  const nw = utc('2026-11-04T09:00:00Z');
  const state = freshState();
  state.pairs[PAIR] = { last1m: nw + 900, last15: nw };
  const { events, skipped } = processPair(state, PAIR, daPlayData(nw, true), nw + 960, { ok: true, events: [] });
  assert.deepEqual(skipped, []);
  const l = events[0].level;
  assert.equal(l.playType, 'da');
  assert.equal(l.num, 1);
  assert.equal(l.setup.stop, 0.701);
  assert.equal(l.setup.tp, 0.7066);
  const text = formatEvent(events[0]);
  assert.ok(text.includes('<b>#01 AUDUSD 🧪 15m') &&text.includes('DA PLAY (experimental)'), text);
  assert.ok(text.includes('0.7011–0.7013'), text);
  assert.ok(journalRow(l).includes(',da,'));
});

test('DA play: the same no-wick without a decision area stays skipped for trend', () => {
  const nw = utc('2026-11-04T09:00:00Z');
  const state = freshState();
  state.pairs[PAIR] = { last1m: nw + 900, last15: nw };
  const { events, skipped } = processPair(state, PAIR, daPlayData(nw, false), nw + 960, { ok: true, events: [] });
  assert.equal(events.length, 0);
  assert.match(skipped[0].reason, /^trend/);
  assert.equal(state.levels[0].playType, undefined);
});

test('recap lists DA plays separately from the main numbers', () => {
  const text = recapText([{ outcome: 'won', pair: PAIR, tf: 900 }], 2, [], {
    alerts: 1, reported: [], results: [{ outcome: 'lost', pair: PAIR, tf: 900, play: 'da' }],
  });
  assert.ok(text.includes('2 setup alert(s)'));
  assert.ok(text.includes('All: 1W / 0L (100%)'));
  assert.ok(text.includes('🧪 <b>DA plays (experimental)</b> — 1 alert(s)'));
  assert.ok(text.includes('All: 0W / 1L (0%)'));
  assert.ok(!recapText([], 0, [], { alerts: 0, reported: [], results: [] }).includes('DA plays'));
});
