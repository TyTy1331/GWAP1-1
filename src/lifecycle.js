import { config, instrument } from './config.js';
import { addMarketBars, marketBarIndex, newsMute, sessionAt, nextDailyClose } from './filters.js';

// Silent levels are tracked for the journal but never alerted or counted: skipped setups (shadow)
// and alerted ones that became invalid (you said so, near miss then TP, or tapped in no-trade hours).
export const silent = (l) => Boolean(l.shadow || l.invalid);

export function newLevel({ pair, tf, candle, dir, setup, internal, external, session, num }) {
  const close = candle.time + tf;
  return {
    id: `${pair}:${candle.time}:${dir}`, num,
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

// Bard's management rule: when a no-wick forms against an open trade, move the stop to break-even
// if the trade is in profit, or move TP to break-even if it is in drawdown.
export function breakEvenSignals(state, pair, candle, dir, closeTime) {
  const events = [];
  for (const l of state.levels) {
    if (l.pair !== pair || l.status !== 'tracking' || l.dir === dir || l.beSignal || candle.time < l.tapTime) continue;
    const inProfit = l.dir === 'bull' ? candle.close > l.level : candle.close < l.level;
    l.beSignal = { time: closeTime, at: candle.open, mode: inProfit ? 'stop' : 'tp' };
    l.managed = inProfit ? { stop: l.level, tp: l.setup.tp } : { stop: l.setup.stop, tp: l.level };
    if (!silent(l) && !l.muted) events.push({ kind: 'be', id: `${l.id}:be`, level: l, time: closeTime });
  }
  return events;
}

// The "managed" result is what you'd get following the break-even rule; it always settles at or
// before the plain 1:1 result, so it is checked first each minute.
function advanceManaged(l, c) {
  if (!l.managed || l.managedResult) return;
  const m = l.managed, bull = l.dir === 'bull';
  const stopHit = bull ? c.low <= m.stop : c.high >= m.stop;
  const tpHit = bull ? c.high >= m.tp : c.low <= m.tp;
  if (stopHit) l.managedResult = m.stop === l.level ? 'BE' : 'SL';
  else if (tpHit) l.managedResult = m.tp === l.level ? 'BE' : 'TP';
}

const result = (l, outcome, t, extra = {}) => ({ id: l.id, pair: l.pair, tf: l.tf, dir: l.dir, outcome: l.muted ? 'muted' : outcome, formed: l.formedClose, tapped: l.tapTime, closed: t, ...extra, ...(silent(l) ? { shadow: true } : {}), ...(l.playType ? { play: l.playType } : {}) });

function resolve(l, outcome, t, results) {
  l.status = outcome === 'won' ? 'won' : 'lost';
  l.resultTime = t;
  l.managedResult ??= outcome === 'won' ? 'TP' : 'SL';
  results.push(result(l, outcome, t));
  return l.muted ? [] : [{ kind: 'result', id: `${l.id}:result`, level: l, outcome, time: t }];
}

// Prop-firm rule: nothing is held over the daily close. The trade ends at the current price.
function flatten(l, c, results) {
  const r = (l.dir === 'bull' ? c.open - l.level : l.level - c.open) / Math.abs(l.level - l.setup.stop);
  Object.assign(l, { status: 'closed', resultTime: c.time, closedR: Math.round(r * 10) / 10 });
  l.managedResult ??= 'closed';
  results.push(result(l, 'closed', c.time, { r: l.closedR }));
  return l.muted ? [] : [{ kind: 'result', id: `${l.id}:result`, level: l, outcome: 'closed', time: c.time }];
}

// Replays one closed 1-minute candle against every live level of its pair. Returns alert events.
export function advanceMinute(state, pair, c, newsEvents) {
  const events = [], near = config.nearMissPips * instrument(pair).unit;
  for (const l of state.levels) {
    if (l.pair !== pair || c.time < l.formedClose) continue;
    const out = [];
    if (l.status === 'active') {
      if (c.time >= l.deadline) { l.status = 'expired'; continue; }
      if (!touches(l, c)) {
        // Came really close, never tapped, then ran to TP: the move went without the entry.
        if (l.nearMiss && !l.invalid && hitTp(l, c)) {
          if (!silent(l)) events.push({ kind: 'invalid', id: `${l.id}:invalid`, level: l, time: c.time });
          Object.assign(l, { invalid: 'near miss, then ran to TP', invalidAt: c.time });
        } else if (l.dir === 'bull' ? c.low <= l.level + near : c.high >= l.level - near) l.nearMiss = true;
        continue;
      }
      l.status = 'tracking';
      l.tapTime = c.time;
      l.tapIndex = marketBarIndex(l.windowStart, c.time, l.tf);
      if (!l.invalid && !sessionAt(c.time)) Object.assign(l, { invalid: 'tapped in no-trade hours', invalidAt: c.time });
      l.muted = newsMute(newsEvents, pair, c.time);
      if (!l.muted) out.push({ kind: 'tap', id: `${l.id}:tap`, level: l, time: c.time });
      // In the tap minute only the stop counts: a wide minute can't fake a win.
      if (hitStop(l, c)) out.push(...resolve(l, 'lost', c.time, state.results));
    } else if (l.status === 'tracking') {
      advanceManaged(l, c);
      l.flatAt ??= nextDailyClose(l.tapTime) - config.flatBeforeCloseMinutes * 60;
      if (c.time >= l.flatAt) out.push(...flatten(l, c, state.results));
      else if (hitStop(l, c)) out.push(...resolve(l, 'lost', c.time, state.results));
      else if (hitTp(l, c)) out.push(...resolve(l, 'won', c.time, state.results));
    }
    if (!silent(l)) events.push(...out); // silent setups are tracked, never alerted
  }
  return events;
}

// Missing 1m history beyond normal closures: live levels can't be judged honestly.
export function markDataGap(state, pair, from, to) {
  const hit = state.levels.filter((l) => l.pair === pair && (l.status === 'active' || l.status === 'tracking'));
  for (const l of hit) {
    if (l.status === 'tracking') state.results.push({ ...result(l, 'unknown', to), outcome: 'unknown' });
    l.status = 'unknown';
  }
  return [{ kind: 'gap', id: `${pair}:gap:${from}`, pair, from, to, count: hit.filter((l) => !silent(l)).length, time: to }];
}

export function prune(state, now) {
  const cutoff = now - config.pruneDays * 86400;
  state.levels = state.levels.filter((l) => l.status === 'active' || l.status === 'tracking' || l.formedClose > cutoff
    || (l.reported && l.formedClose > now - 90 * 86400)); // your reports feed /stats for 30 days
  for (const k of ['sent', 'failed']) {
    for (const [id, t] of Object.entries(state[k])) if (t < cutoff) delete state[k][id];
  }
  state.results = state.results.filter((r) => r.closed > now - 90 * 86400);
}
