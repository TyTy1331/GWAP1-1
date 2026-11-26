import { pathToFileURL } from 'node:url';
import { config, TF, TF_KEY, TF_LABEL, instrument } from './config.js';
import { fetchCandles, credentialsFromEnv, isFresh, FeedError } from './candles.js';
import { noWickDir, upgradesLevel } from './nowick.js';
import { analyze, trendAt, isValid } from './structure.js';
import { buildSetup, recentNoWicks } from './setup.js';
import { sessionAt, marketOpen, latestMarketClose, marketMinutesBetween, refreshNews, newsMute, upcomingNews, inWindow } from './filters.js';
import { newLevel, upgrade, advanceMinute, markDataGap, prune, breakEvenSignals, silent } from './lifecycle.js';
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
// Timeframes come from the instrument: no-wicks on inst.tf (15m for forex), upgrades to inst.ups,
// external trend on inst.ext. `ps.last15` is the last processed close of inst.tf.
export function processPair(state, pair, data, until, news) {
  const ps = state.pairs[pair], inst = instrument(pair);
  const events = [], skipped = [];
  const m1 = data.m1, base = data[TF_KEY[inst.tf]], ext = data[TF_KEY[inst.ext]];

  if (m1.length && m1[0].time > ps.last1m && marketMinutesBetween(ps.last1m, m1[0].time, pair) > inst.gapToleranceMinutes) {
    events.push(...markDataGap(state, pair, ps.last1m, m1[0].time));
  }

  const items = [];
  for (const c of m1) if (c.time >= ps.last1m && c.time + 60 <= until) items.push({ t: c.time + 60, prio: 0, c });
  const addCloses = (list, tf, prio) => {
    if (!list) return;
    list.forEach((c, i) => { const t = c.time + tf; if (t > ps.last15 && t <= until) items.push({ t, prio, tf, c, i, list }); });
  };
  addCloses(base, inst.tf, 1);
  inst.ups.forEach((tf, k) => addCloses(data[TF_KEY[tf]], tf, 2 + k));
  items.sort((a, b) => a.t - b.t || a.prio - b.prio);

  const aBase = base && analyze(base, inst.tf), aExt = ext && analyze(ext, inst.ext);
  const aHigher = Object.fromEntries(inst.ups.map((tf) => [tf, data[TF_KEY[tf]] && analyze(data[TF_KEY[tf]], tf)]));
  const upToHere = (list, i) => list.slice(Math.max(0, i - config.structureBars + 1), i + 1);
  const daCache = new Map();
  const dasAt = (t) => {
    if (!inst.da) return [];
    if (!daCache.has(t)) daCache.set(t, findDAs(base, data.m30, t, inst.unit));
    return daCache.get(t);
  };

  for (const it of items) {
    if (it.prio === 0) {
      events.push(...advanceMinute(state, pair, it.c, news.events));
      ps.last1m = it.t;
      continue;
    }
    if (it.tf === inst.tf) {
      ps.last15 = it.t;
      const dir = noWickDir(it.c);
      if (!dir) continue;
      events.push(...breakEvenSignals(state, pair, it.c, dir, it.t));
      const session = sessionAt(it.t), muted = newsMute(news.events, pair, it.t);
      const internal = trendAt(aBase.bos, it.t), external = trendAt(aExt.bos, it.t);
      const candles = upToHere(base, it.i), das = dasAt(it.t);
      const build = (stopAt) => {
        const s = buildSetup({ dir, candles, swings: aBase.swings, tf: inst.tf, recentLevels: recentNoWicks(candles), stopAt, inst });
        return s && applyDA(s, dir, das);
      };
      let setup = build();
      const trendOnly = session && !muted && !isValid(dir, internal, external);
      // DA play (experimental): counter-trend, but 1 BOS on the 15m and a held decision area behind entry.
      const zone = trendOnly && internal.dir === dir ? daPlayZone(dir, candles, das) : null;
      if (zone) setup = build(dir === 'bull' ? zone.lo : zone.hi);
      // Change of character (GER40): the first internal BOS against the external trend, traded in the new direction.
      const choch = trendOnly && !zone && inst.choch && internal.dir === dir && internal.count === 1;
      const reason = !session ? 'outside session'
        : muted ? 'red-folder news'
        : zone ? (config.da.alertPlays ? null : 'DA play (alerts off)')
        : choch ? (setup ? null : 'no opposite swing for a stop')
        : trendOnly ? `trend (${TF_LABEL[inst.tf]} ${internal.dir ?? '?'}×${internal.count}, ${TF_LABEL[inst.ext]} ${external.dir ?? '?'})`
        : !setup ? 'no opposite swing for a stop' : null;
      // Skipped no-wicks are still tracked silently (no alerts) so the journal shows how they would have done.
      const level = newLevel({ pair, tf: inst.tf, candle: it.c, dir, setup, internal, external, session: session ?? 'none', num: reason ? undefined : nextNum(state) });
      if (zone) Object.assign(level, { playType: 'da', daZone: zone });
      if (choch) level.choch = true;
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
        const built = l.playType ? null : buildSetup({ dir: l.dir, candles, swings: aHigher[it.tf].swings, tf: it.tf, recentLevels: recentNoWicks(candles), inst });
        // Voids are price areas: keep the ones the 15m alert already flagged.
        if (built) built.warnings.push(...l.setup.warnings.filter((w) => w.startsWith('Unfilled void') && !built.warnings.includes(w)));
        const setup = built ? applyDA(built, l.dir, dasAt(it.t)) : l.setup;
        upgrade(l, it.tf, it.c, setup);
        if (!silent(l)) events.push({ kind: 'upgrade', id: `${l.id}:up${it.tf}`, level: l, time: it.t });
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
        state.pairs[pair] = { last1m: floorTo(now, 60), last15: floorTo(now, instrument(pair).tf) };
        continue;
      }
      const ps = state.pairs[pair], inst = instrument(pair);
      const pOpen = open || inst.always, pUntil = inst.always ? now : until; // crypto trades through the forex weekend
      if (ps.last1m >= pUntil) continue;
      // One failed run is harmless (the next run replays what it missed), so only a long stall is reported.
      const stuck = () => marketMinutesBetween(ps.last1m, now, pair) > config.quietFailMinutes;
      try {
        const get = (tf, count) => fetchCandles({ pair, tf, count, now, credentials, getCandles });
        const m1 = await get(TF.M1, 500);
        if (pOpen && !isFresh(m1, now)) {
          const brk = inst.dailyBreak; // e.g. an index's daily close: no candles is normal
          if (stuck() && !(brk && inWindow(now, brk))) warnOnce(state, `stale:${pair}`, now, `TradingView data for ${pair} has been stale for ${config.quietFailMinutes}+ min; alerts paused for this pair.`);
          else log(`${pair}: data stale, will retry next run`);
          continue;
        }
        latestData = Math.max(latestData ?? 0, m1.at(-1).time + 60);
        const data = { m1 };
        if (floorTo(pUntil, inst.tf) > ps.last15) {
          for (const tf of new Set([inst.tf, ...inst.ups, inst.ext, ...(inst.da ? [TF.M30] : [])])) data[TF_KEY[tf]] = await get(tf, 500);
        }
        const { events, skipped } = processPair(state, pair, data, pUntil, state.news);
        for (const e of events) enqueue(state, e.id, formatEvent(e, e.ctx));
        log(`${pair}: ${events.length} event(s), ${skipped.length} no-wick(s) skipped`);
      } catch (e) {
        if (!(e instanceof FeedError)) throw e;
        if (stuck()) warnOnce(state, `feed:${pair}`, now, `${e.message} (no new data for ${config.quietFailMinutes}+ min)`);
        else log(`${pair}: ${e.message} — will retry next run`);
      }
    }

    if (token && chatId && env.DRY_RUN !== '1') {
      try {
        for (const r of await readInbox(state, { token, chatId, fetchFn, now })) enqueue(state, r.id, r.text);
        state.inboxFails = 0;
      } catch (e) {
        // Unread replies wait on Telegram for 24h, so a blip loses nothing; warn only if it keeps failing.
        state.inboxFails = (state.inboxFails ?? 0) + 1;
        if (state.inboxFails >= config.inboxFailRuns) warnOnce(state, 'inbox', now, `Could not read Telegram replies for ${state.inboxFails} runs in a row (${e.message}).`);
        else log(`Telegram replies not read (${e.message}); will retry next run`);
      }
    }

    if (open) {
      const date = checkinDue(state, now);
      if (date) { state.lastCheckin = date; enqueue(state, `checkin:${date}`, checkinText(state, now, latestData ? now - latestData : NaN)); }
    } else if (until && state.lastRecap !== until
      && config.pairs.every((p) => !state.pairs[p] || state.pairs[p].last1m >= until - instrument(p).gapToleranceMinutes * 60)) { // NAS100 stops 15 min before forex
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
      const live = state.levels.filter((l) => !silent(l) && (l.status === 'active' || l.status === 'tracking')).length;
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
