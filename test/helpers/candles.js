// Build candles from [open, high, low, close] tuples, `tf` seconds apart starting at `start`.
export const seq = (start, tf, rows) => rows.map(([open, high, low, close], i) => ({ time: start + i * tf, open, high, low, close }));

// A candle that moves from a to b with small wicks on both sides.
export const move = (a, b, wick = 0.00005) => [a, Math.max(a, b) + wick, Math.min(a, b) - wick, b];

export const utc = (s) => Math.floor(Date.parse(s) / 1000);

// Zig-zag closes through the given points (each leg split into `steps` candles), wicked candles.
export function zigzag(points, steps = 3) {
  const rows = [];
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k], b = points[k + 1];
    for (let s = 0; s < steps; s++) rows.push(move(a + ((b - a) * s) / steps, a + ((b - a) * (s + 1)) / steps));
  }
  return rows.map((r) => r.map((x) => Math.round(x * 1e5) / 1e5));
}
