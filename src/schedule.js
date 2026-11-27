import { instrument } from './config.js';
import { marketOpen, sessionAt } from './filters.js';

// Quiet hours: only 24/7 instruments (BTCUSD, 1H) can alert (the forex weekend, or outside every session)
// and no other trade is still open.
export function quiet(state, now) {
  const fxIdle = !marketOpen(now) || !sessionAt(now);
  return fxIdle && !(state.levels ?? []).some((l) => l.status === 'tracking' && !instrument(l.pair).always);
}

// Outside quiet hours every trigger runs. In quiet hours the first trigger from hh:01 runs (the 1H candle has
// closed), and later ones keep running until a run succeeds that hour (state.lastOk), so a failed run is retried.
export function due(state, now) {
  if (!quiet(state, now)) return true;
  const mark = Math.floor(now / 3600) * 3600 + 60;
  return now >= mark && (state.lastOk ?? 0) < mark;
}
