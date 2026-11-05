import { pathToFileURL } from 'node:url';
import { config, TF } from './config.js';
import { fetchCandles, credentialsFromEnv, isFresh, FeedError } from './candles.js';
import { noWickDir, upgradesLevel } from './nowick.js';
import { analyze, trendAt, isValid } from './structure.js';
import { buildSetup, recentNoWicks } from './setup.js';
import { sessionAt, marketOpen, latestMarketClose, marketMinutesBetween, refreshNews, newsMute, upcomingNews } from './filters.js';
import { newLevel, upgrade, advanceMinute, markDataGap, prune, breakEvenSignals } from './lifecycle.js';
import { loadState, saveState } from './state.js';
import { formatEvent, enqueue, deliver, TelegramError } from './telegram.js';
import { checkinDue, checkinText, recapText } from './reports.js';
import { readInbox } from './inbox.js';
import { syncJournal } from './journal.js';
import { findDAs, applyDA, daPlayZone } from './da.js';
import { dirname, join } from 'node:path';

const nextNum = (state) => { const n = state.nextNum ?? 1; state.nextNum = n + 1; return n; };

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
  const daCache = new Map();
  const dasAt = (t) => { if (!daCache.has(t)) daCache.set(t, findDAs(m15, m30, t)); return daCache.get(t); };

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
      events.push(...breakEvenSignals(state, pair, it.c, dir, it.t));
      const session = sessionAt(it.t), muted = newsMute(news.events, pair, it.t);
      const internal = trendAt(a15.bos, it.t), external = trendAt(a4.bos, it.t);
      const candles = upToHere(m15, it.i), das = dasAt(it.t);
      const build = (stopAt) => {
        const s = buildSetup({ dir, candles, swings: a15.swings, tf: TF.M15, recentLevels: recentNoWicks(candles), stopAt });
        return s && applyDA(s, dir, das);
      };
      let setup = build();
      const trendOnly = session && !muted && !isValid(dir, internal, external);
      // DA play (experimental): counter-trend, but 1 BOS on the 15m and a held decision area behind entry.
      const zone = trendOnly && internal.dir === dir ? daPlayZone(dir, candles, das) : null;
      if (zone) setup = build(dir === 'bull' ? zone.lo : zone.hi);
      const reason = !session ? 'outside session'
        : muted ? 'red-folder news'
        : zone ? (config.da.alertPlays ? null : 'DA play (alerts off)')
        : trendOnly ? `trend (15m ${internal.dir ?? '?'}×${internal.count}, 4H ${external.dir ?? '?'})`
        : !setup ? 'no opposite swing for a stop' : null;
      // Skipped no-wicks are still tracked silently (no alerts) so the journal shows how they would have done.
      const level = newLevel({ pair, tf: TF.M15, candle: it.c, dir, setup, internal, external, session: session ?? 'none', num: reason ? undefined : nextNum(state) });
      if (zone) Object.assign(level, { playType: 'da', daZone: zone });
      state.levels.push(level);
      if (reason) {
        skipped.push({ time: it.t, dir, level: it.c.open, reason });
        Object.assign(level, { shadow: true, skipReason: reason, ...(setup ? {} : { status: 'nosetup' }) });
        continue;
      }
      events.push({ kind: 'formed', id: `${level.id}:formed`, level, time: it.t,
        ctx: { upcoming: upcomingNews(news.events, pair, it.t), newsUnavailable: !news.ok } });
    } else {
      for (const l of state.levels) {
        if (l.pair !== pair || l.tf >= it.tf || !upgradesLevel(l, it.c)) continue;
        const candles = upToHere(it.list, it.i);
        // DA plays keep their stop beyond the decision area.
        const built = l.playType ? null : buildSetup({ dir: l.dir, candles, swings: aHigher[it.tf].swings, tf: it.tf, recentLevels: recentNoWicks(candles) });
        // Voids are price areas: keep the ones the 15m alert already flagged.
        if (built) built.warnings.push(...l.setup.warnings.filter((w) => w.startsWith('Unfilled void') && !built.warnings.includes(w)));
        const setup = built ? applyDA(built, l.dir, dasAt(it.t)) : l.setup;
        upgrade(l, it.tf, it.c, setup);
        if (!l.shadow) events.push({ kind: 'upgrade', id: `${l.id}:up${it.tf}`, level: l, time: it.t });
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
  const token = env.TELEGRAM_BOT_TOKEN?.trim(), chatId = env.TELEGRAM_CHAT_ID?.trim();
  // Alerted levels saved before trade numbers existed get one; skipped (shadow) setups never have one.
  for (const l of state.levels) {
    if (l.shadow) delete l.num;
    else if (!l.num && (l.status === 'active' || l.status === 'tracking')) l.num = nextNum(state);
  }

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

    if (token && chatId && env.DRY_RUN !== '1') {
      try {
        for (const r of await readInbox(state, { token, chatId, fetchFn, now })) enqueue(state, r.id, r.text);
      } catch (e) { warnOnce(state, 'inbox', now, `Could not read Telegram replies (${e.message}).`); }
    }

    if (open) {
      const date = checkinDue(state, now);
      if (date) { state.lastCheckin = date; enqueue(state, `checkin:${date}`, checkinText(state, now, latestData ? now - latestData : NaN)); }
    } else if (until && state.lastRecap !== until
      && config.pairs.every((p) => !state.pairs[p] || state.pairs[p].last1m >= until - 300)) {
      state.lastRecap = until;
      const week = (t) => t > until - 7 * 86400 && t <= until;
      const alerted = (l, play) => !l.shadow && (l.playType ?? null) === play && week(l.formedClose);
      const section = (play) => ({
        alerts: state.levels.filter((l) => alerted(l, play)).length,
        reported: state.levels.filter((l) => l.reported && alerted(l, play)),
        results: state.results.filter((r) => !r.shadow && (r.play ?? null) === play && week(r.closed)),
      });
      const main = section(null), da = section('da');
      enqueue(state, `recap:${until}`, recapText(main.results, main.alerts, main.reported, da));
    }
    prune(state, now);
    if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.RUN_SOURCE !== 'cron') { // cron-job.org triggers stay silent
      const live = state.levels.filter((l) => !l.shadow && (l.status === 'active' || l.status === 'tracking')).length;
      enqueue(state, `manual:${now}`, `✅ Manual run OK. Market ${open ? 'open' : 'closed'}, ${live} live level(s).`);
    }

    if (env.DRY_RUN === '1') {
      for (const m of state.outbox) log(`--- ${m.id}\n${m.text}`);
      state.outbox = [];
    } else {
      if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (or DRY_RUN=1).');
      await deliver(state, { token, chatId, fetchFn, now, wait, log });
    }
  } catch (e) {
    exitCode = 1;
    log(`Run failed: ${e instanceof TelegramError || e instanceof FeedError ? e.message : e?.message ?? e}`);
  } finally {
    try {
      const n = syncJournal(state, join(dirname(statePath), 'journal'));
      if (n) log(`Journal: ${n} row(s) written`);
    } catch (e) { log(`Journal write failed: ${e.message}`); }
    saveState(statePath, state); // always, so sent IDs and progress survive a failed run
  }
  log(`Done. outbox=${state.outbox.length} levels=${state.levels.filter((l) => l.status === 'active' || l.status === 'tracking').length}`);
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runOnce();
}
