// Bullish: closes up with no bottom wick (open = low). Bearish: closes down with no top wick (open = high).
export function noWickDir(c) {
  if (c.close > c.open && c.open === c.low) return 'bull';
  if (c.close < c.open && c.open === c.high) return 'bear';
  return null;
}

// A higher-timeframe candle upgrades a level when it starts with the level's candle,
// opens at the same price and is itself a no-wick in the same direction.
export function upgradesLevel(level, higher) {
  return level.status === 'active'
    && level.candleOpen === higher.time
    && higher.open === level.level
    && noWickDir(higher) === level.dir;
}
