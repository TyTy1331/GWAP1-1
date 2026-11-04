import test from 'node:test';
import assert from 'node:assert/strict';
import { findSwings, findBos, trendAt, isValid, analyze, isDoji } from '../src/structure.js';
import { seq, zigzag } from './helpers/candles.js';

const TF = 900;

test('rising zig-zag: bullish BOS events with increasing count', () => {
  const candles = seq(0, TF, zigzag([0.700, 0.702, 0.701, 0.703, 0.702, 0.704, 0.703, 0.705]));
  const { bos } = analyze(candles, TF);
  assert.ok(bos.length >= 2);
  assert.ok(bos.every((e) => e.dir === 'bull'));
  const t = trendAt(bos, Infinity);
  assert.equal(t.dir, 'bull');
  assert.equal(t.count, bos.length);
});

test('a wick above the swing high without a body close beyond it is not a BOS', () => {
  const rows = zigzag([0.700, 0.702, 0.701], 3);
  rows.push([0.7012, 0.7030, 0.7010, 0.7015]); // wick to 0.7030, body stays below 0.702
  rows.push([0.7015, 0.7017, 0.7008, 0.7010]);
  const candles = seq(0, TF, rows);
  assert.equal(analyze(candles, TF).bos.length, 0);
});

test('a doji at the would-be pivot is skipped', () => {
  const rows = zigzag([0.700, 0.702, 0.700], 3);
  rows.splice(3, 0, [0.7022, 0.7030, 0.7015, 0.70221]); // doji with the highest body, ignored
  const swings = findSwings(seq(0, TF, rows), TF);
  assert.ok(isDoji({ open: 0.7022, high: 0.7030, low: 0.7015, close: 0.70221 }));
  assert.ok(swings.every((s) => s.level < 0.7022));
});

test('pivot is not usable before its two right-hand candles close', () => {
  const candles = seq(0, TF, zigzag([0.700, 0.702, 0.701, 0.703]));
  const swings = findSwings(candles, TF);
  const hi = swings.find((s) => s.type === 'high');
  assert.ok(hi.confirmedAt >= hi.time + 3 * TF);
  const bos = findBos(candles, swings, TF);
  assert.ok(bos.every((e) => e.time > e.swing.confirmedAt));
});

test('a bearish BOS between bullish ones resets the count', () => {
  const bos = [{ dir: 'bull', time: 1 }, { dir: 'bear', time: 2 }, { dir: 'bull', time: 3 }];
  assert.deepEqual(trendAt(bos, 3), { dir: 'bull', count: 1 });
  assert.deepEqual(trendAt(bos, 2), { dir: 'bear', count: 1 });
  assert.deepEqual(trendAt([], 3), { dir: null, count: 0 });
});

test('AE1: aligned with 4H, one BOS is enough', () => {
  assert.equal(isValid('bull', { dir: 'bull', count: 1 }, { dir: 'bull', count: 3 }), true);
});

test('AE2: against the 4H needs two consecutive BOS', () => {
  assert.equal(isValid('bull', { dir: 'bull', count: 1 }, { dir: 'bear', count: 2 }), false);
  assert.equal(isValid('bull', { dir: 'bull', count: 2 }, { dir: 'bear', count: 2 }), true);
});

test('unknown internal trend is invalid; unknown 4H is treated as against', () => {
  assert.equal(isValid('bull', { dir: null, count: 0 }, { dir: 'bull', count: 1 }), false);
  assert.equal(isValid('bull', { dir: 'bull', count: 1 }, { dir: null, count: 0 }), false);
});

test('too little history: no swings, no BOS, no error', () => {
  const { swings, bos } = analyze(seq(0, TF, zigzag([0.7, 0.701])), TF);
  assert.equal(swings.length, 0);
  assert.equal(bos.length, 0);
});
