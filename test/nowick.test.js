import test from 'node:test';
import assert from 'node:assert/strict';
import { noWickDir, upgradesLevel } from '../src/nowick.js';

const c = (open, high, low, close, time = 0) => ({ time, open, high, low, close });

test('bullish no-wick: open = low and closes up', () => {
  assert.equal(noWickDir(c(0.7, 0.7006, 0.7, 0.7005)), 'bull');
  assert.equal(noWickDir(c(0.7, 0.7006, 0.7, 0.7)), null, 'flat close is not a no-wick');
});

test('bearish no-wick mirrors; zero range and wicked candles are none', () => {
  assert.equal(noWickDir(c(0.7, 0.7, 0.6994, 0.6995)), 'bear');
  assert.equal(noWickDir(c(0.7, 0.7, 0.7, 0.7)), null);
  assert.equal(noWickDir(c(0.7, 0.7006, 0.69999, 0.7005)), null);
});

test('upgrade needs same start, same open, same direction, untapped', () => {
  const level = { status: 'active', candleOpen: 100, level: 0.7, dir: 'bull' };
  assert.equal(upgradesLevel(level, c(0.7, 0.701, 0.7, 0.7008, 100)), true);
  assert.equal(upgradesLevel(level, c(0.7, 0.701, 0.6999, 0.7008, 100)), false, 'higher candle has a bottom wick');
  assert.equal(upgradesLevel(level, c(0.7, 0.701, 0.7, 0.7008, 1000)), false, 'different start');
  assert.equal(upgradesLevel({ ...level, status: 'tracking' }, c(0.7, 0.701, 0.7, 0.7008, 100)), false, 'already tapped');
});
