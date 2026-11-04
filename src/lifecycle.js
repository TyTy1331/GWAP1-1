import { config } from './config.js';
import { addMarketBars, marketBarIndex, newsMute } from './filters.js';

export function newLevel({ pair, tf, candle, dir, setup, internal, external, session }) {
  const close = candle.time + tf;
  return {
    id: `${pair}:${candle.time}:${dir}`,
    pair, tf, dir, candleOpen: candle.time, level: candle.open, formedClose: close,
    windowStart: close, deadline: addMarketBars(close, config.tapWindowCandles, tf),
    setup, internal, external, session, status: 'active', upgrades: [],
  };
}

export function upgrade(level, tf, higher, setup) {
  const close = higher.time + tf;
  Object.assign(level, { tf, setup, windowStart: close, deadline: addMarketBars(close, config.tapWindowCandles, tf) });
  level.upgrades.push(tf);
}

const touches = (l, c) => (l.dir === 'bull' ? c.low <= l.level : c.high >= l.level);
const hitStop = (l, c) => (l.dir === 'bull' ? c.low <= l.setup.stop : c.high >= l.setup.stop);
const hitTp = (l, c) => (l.dir === 'bull' ? c.high >= l.setup.tp : c.low <= l.setup.tp);

function resolve(l, outcome, t, results) {
  l.status = outcome === 'won' ? 'won' : 'lost';
  l.resultTime = t;
  results.push({ id: l.id, pair: l.pair, tf: l.tf, dir: l.dir, outcome: l.muted ? 'muted' : outcome, formed: l.formedClose, tapped: l.tapTime, closed: t });
  return l.muted ? [] : [{ kind: 'result', id: `${l.id}:result`, level: l, outcome, time: t }];
}

// Replays one closed 1-minute candle against every live level of its pair. Returns alert events.
export function advanceMinute(state, pair, c, newsEvents) {
  const events = [];
  for (const l of state.levels) {
    if (l.pair !== pair || c.time < l.formedClose) continue;
    if (l.status === 'active') {
      if (c.time >= l.deadline) { l.status = 'expired'; continue; }
      if (!touches(l, c)) continue;
      l.status = 'tracking';
      l.tapTime = c.time;
      l.tapIndex = marketBarIndex(l.windowStart, c.time, l.tf);
      l.muted = newsMute(newsEvents, pair, c.time);
      if (!l.muted) events.push({ kind: 'tap', id: `${l.id}:tap`, level: l, time: c.time });
      // In the tap minute only the stop counts: a wide minute can't fake a win.
      if (hitStop(l, c)) events.push(...resolve(l, 'lost', c.time, state.results));
    } else if (l.status === 'tracking') {
      if (hitStop(l, c)) events.push(...resolve(l, 'lost', c.time, state.results));
      else if (hitTp(l, c)) events.push(...resolve(l, 'won', c.time, state.results));
    }
  }
  return events;
}

// Missing 1m history beyond normal closures: live levels can't be judged honestly.
export function markDataGap(state, pair, from, to) {
  const hit = state.levels.filter((l) => l.pair === pair && (l.status === 'active' || l.status === 'tracking'));
  for (const l of hit) {
    if (l.status === 'tracking') state.results.push({ id: l.id, pair, tf: l.tf, dir: l.dir, outcome: 'unknown', formed: l.formedClose, tapped: l.tapTime, closed: to });
    l.status = 'unknown';
  }
  return [{ kind: 'gap', id: `${pair}:gap:${from}`, pair, from, to, count: hit.length, time: to }];
}

export function prune(state, now) {
  const cutoff = now - config.pruneDays * 86400;
  state.levels = state.levels.filter((l) => l.status === 'active' || l.status === 'tracking' || l.formedClose > cutoff);
  for (const k of ['sent', 'failed']) {
    for (const [id, t] of Object.entries(state[k])) if (t < cutoff) delete state[k][id];
  }
  state.results = state.results.filter((r) => r.closed > now - 90 * 86400);
}
