import { pathToFileURL } from 'node:url';
import { config, TF } from './config.js';
import { fetchCandles, credentialsFromEnv, isFresh, FeedError } from './candles.js';
import { noWickDir, upgradesLevel } from './nowick.js';
import { analyze, trendAt, isValid } from './structure.js';
import { buildSetup, recentNoWicks } from './setup.js';
import { sessionAt, marketOpen, latestMarketClose, marketMinutesBetween, refreshNews, newsMute, upcomingNews } from './filters.js';
import { newLevel, upgrade, advanceMinute, markDataGap, prune } from './lifecycle.js';
import { loadState, saveState } from './state.js';
import { formatEvent, enqueue, deliver, TelegramError } from './telegram.js';
import { checkinDue, checkinText, recapText } from './reports.js';

const floorTo = (t, tf) => Math.floor(t / tf) * tf;

function warnOnce(state, key, now, text) {
  if (state.throttle[key] && now - state.throttle[key] < 3600) return;
  state.throttle[key] = now;
  enqueue(state, `warn:${key}:${floorTo(now, 3600)}`, `⚠️ ${text}`);
}

// Replays one pair's candles in time order: every 1m candle up to a higher-timeframe close
// is processed before that close, so detection and upgrades always see earlier taps.
export function processPair(state, pair, data, until, news) {
  const ps = state.pairs[pair];
  const events = [], skipped = [];
  const { m1, m15, m30, h1, h4 } = data;

  if (m1.length && m1[0].time > ps.last1m && marketMinutesBetween(ps.last1m, m1[0].time) > config.dataGapToleranceMinutes) {
    events.push(...markDataGap(state, pair, ps.last1m, m1[0].time));
  }

  const items = [];
  for (const c of m1) if (c.time >= ps.last1m && c.time + 60 <= until) items.push({ t: c.time + 60, prio: 0, c });
  const addCloses = (list, tf, prio) => {
    if (!list) return;
    list.forEach((c, i) => { const t = c.time + tf; if (t > ps.last15 && t <= until) items.push({ t, prio, tf, c, i, list }); });
  };
  addCloses(m15, TF.M15, 1); addCloses(m30, TF.M30, 2); addCloses(h1, TF.H1, 3);
  items.sort((a, b) => a.t - b.t || a.prio - b.prio);

  const a15 = m15 && analyze(m15, TF.M15), a4 = h4 && analyze(h4, TF.H4);
  const aHigher = { [TF.M30]: m30 && analyze(m30, TF.M30), [TF.H1]: h1 && analyze(h1, TF.H1) };
  const upToHere = (list, i) => list.slice(Math.max(0, i - config.structureBars + 1), i + 1);

  for (const it of items) {
    if (it.prio === 0) {
      events.push(...advanceMinute(state, pair, it.c, news.events));
      ps.last1m = it.t;
      continue;
    }
    if (it.tf === TF.M15) {
      ps.last15 = it.t;
      const dir = noWickDir(it.c);
      if (!dir) continue;
      const why = (reason) => skipped.push({ time: it.t, dir, level: it.c.open, reason });
      const session = sessionAt(it.t);
      if (!session) { why('outside session'); continue; }
      if (newsMute(news.events, pair, it.t)) { why('red-folder news'); continue; }
      const internal = trendAt(a15.bos, it.t), external = trendAt(a4.bos, it.t);
      if (!isValid(dir, internal, external)) { why(`trend (15m ${internal.dir ?? '?'}×${internal.count}, 4H ${external.dir ?? '?'})`); continue; }
      const candles = upToHere(m15, it.i);
      const setup = buildSetup({ dir, candles, swings: a15.swings, tf: TF.M15, recentLevels: recentNoWicks(candles) });
      if (!setup) { why('no opposite swing for a stop'); continue; }
      const level = newLevel({ pair, tf: TF.M15, candle: it.c, dir, setup, internal, external, session });
      state.levels.push(level);
      events.push({ kind: 'formed', id: `${level.id}:formed`, level, time: it.t,
        ctx: { upcoming: upcomingNews(news.events, pair, it.t), newsUnavailable: !news.ok } });
    } else {
      for (const l of state.levels) {
        if (l.pair !== pair || l.tf >= it.tf || !upgradesLevel(l, it.c)) continue;
        const candles = upToHere(it.list, it.i);
        const setup = buildSetup({ dir: l.dir, candles, swings: aHigher[it.tf].swings, tf: it.tf, recentLevels: recentNoWicks(candles) }) ?? l.setup;
        upgrade(l, it.tf, it.c, setup);
        events.push({ kind: 'upgrade', id: `${l.id}:up${it.tf}`, level: l, time: it.t });
      }
    }
  }
  return { events, skipped };
}

export async function runOnce({ now = Math.floor(Date.now() / 1000), env = process.env, getCandles, fetchFn = fetch, log = console.log, wait } = {}) {
  const statePath = env.STATE_PATH ?? 'state/state.json';
  const { state, fresh, reason } = loadState(statePath);
  if (fresh && reason !== 'no state file') warnOnce(state, 'state-reset', now, `State could not be read (${reason}); starting fresh.`);
  const credentials = credentialsFromEnv(env, (w) => warnOnce(state, 'tv-creds', now, w));
  const open = marketOpen(now);
  const until = open ? now : latestMarketClose(now);
  let exitCode = 0, latestData = null;

  try {
    state.news = await refreshNews(state.news, now, fetchFn);
    if (!state.news.ok) warnOnce(state, 'news', now, 'News calendar unavailable; alerts carry a reminder to check it yourself.');

    for (const pair of config.pairs) {
      if (!state.pairs[pair]) {
        // Fresh start: begin at "now" so old candles never trigger alerts.
        state.pairs[pair] = { last1m: floorTo(now, 60), last15: floorTo(now, TF.M15) };
        continue;
      }
      const ps = state.pairs[pair];
      if (ps.last1m >= until) continue;
      try {
        const get = (tf, count) => fetchCandles({ pair, tf, count, now, credentials, getCandles });
        const m1 = await get(TF.M1, 500);
        if (open && !isFresh(m1, now)) { warnOnce(state, `stale:${pair}`, now, `TradingView data for ${pair} is stale; alerts paused for this pair.`); continue; }
        latestData = Math.max(latestData ?? 0, m1.at(-1).time + 60);
        const data = { m1 };
        if (floorTo(until, TF.M15) > ps.last15) {
          Object.assign(data, { m15: await get(TF.M15, 500), m30: await get(TF.M30, 500), h1: await get(TF.H1, 500), h4: await get(TF.H4, 500) });
        }
        const { events, skipped } = processPair(state, pair, data, until, state.news);
        for (const e of events) enqueue(state, e.id, formatEvent(e, e.ctx));
        log(`${pair}: ${events.length} event(s), ${skipped.length} no-wick(s) skipped`);
      } catch (e) {
        if (!(e instanceof FeedError)) throw e;
        warnOnce(state, `feed:${pair}`, now, e.message);
      }
    }

    if (open) {
      const date = checkinDue(state, now);
      if (date) { state.lastCheckin = date; enqueue(state, `checkin:${date}`, checkinText(state, now, latestData ? now - latestData : NaN)); }
    } else if (until && state.lastRecap !== until
      && config.pairs.every((p) => !state.pairs[p] || state.pairs[p].last1m >= until - 300)) {
      state.lastRecap = until;
      const week = (t) => t > until - 7 * 86400 && t <= until;
      const alerts = state.levels.filter((l) => week(l.formedClose)).length;
      enqueue(state, `recap:${until}`, recapText(state.results.filter((r) => week(r.closed)), alerts));
    }
    prune(state, now);
    if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
      const live = state.levels.filter((l) => l.status === 'active' || l.status === 'tracking').length;
      enqueue(state, `manual:${now}`, `✅ Manual run OK. Market ${open ? 'open' : 'closed'}, ${live} live level(s).`);
    }

    if (env.DRY_RUN === '1') {
      for (const m of state.outbox) log(`--- ${m.id}\n${m.text}`);
      state.outbox = [];
    } else {
      const token = env.TELEGRAM_BOT_TOKEN?.trim(), chatId = env.TELEGRAM_CHAT_ID?.trim();
      if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (or DRY_RUN=1).');
      await deliver(state, { token, chatId, fetchFn, now, wait, log });
    }
  } catch (e) {
    exitCode = 1;
    log(`Run failed: ${e instanceof TelegramError || e instanceof FeedError ? e.message : e?.message ?? e}`);
  } finally {
    saveState(statePath, state); // always, so sent IDs and progress survive a failed run
  }
  log(`Done. outbox=${state.outbox.length} levels=${state.levels.filter((l) => l.status === 'active' || l.status === 'tracking').length}`);
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runOnce();
}
