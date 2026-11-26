import { config, TF_LABEL, instrument } from './config.js';
import { localParts } from './filters.js';
import { silent } from './lifecycle.js';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fmtTime(t) {
  const p = localParts(t, config.displayZone);
  const hh = String(Math.floor(p.minutes / 60)).padStart(2, '0'), mm = String(p.minutes % 60).padStart(2, '0');
  return `${p.weekday} ${p.date.slice(5)} ${hh}:${mm} SAST`;
}

// Short form for alert bodies: "Fri 19:00".
export function clock(t) {
  const p = localParts(t, config.displayZone);
  return `${p.weekday} ${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`;
}

const name = (pair) => pair.split(':').pop();
export const tag = (num) => (num ? `#${String(num).padStart(2, '0')}` : '');
const head = (l) => `${tag(l.num) ? `${tag(l.num)} ` : ''}${esc(name(l.pair))}${l.playType === 'da' ? ' 🧪' : ''}`;
const side = (dir) => (dir === 'bull' ? 'BUY' : 'SELL');
const dot = (dir) => (dir === 'bull' ? '🟢' : '🔴');
const trend = (t) => (t.dir ? `${t.dir === 'bull' ? 'bullish' : 'bearish'} (${t.count} BOS)` : 'unclear');
// A+: the internal and external trend both point the trade's way (journal Nov 4–25: 65% vs 38% when against).
export const aPlus = (l) => l.internal?.dir === l.dir && l.external?.dir === l.dir;
const title = (l) => `<b>${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)}${aPlus(l) ? ' ⭐ A+' : ''}${l.choch ? ' 🔄 CHoCH' : ''}</b>`;

// A titled block, or nothing when it has no lines. Blocks are separated by a blank line.
const block = (heading, lines) => (lines.length ? [heading, ...lines].join('\n') : '');
const blocks = (...b) => b.filter(Boolean).join('\n\n');
const notes = (l) => block('ℹ️ <b>Good to know</b>', (l.setup.notes ?? []).map((n) => `• ${esc(n)}`));

// Alerts name the trade and its confluences only; entry, stop and TP are the trader's call.
export function formatEvent(e, ctx = {}) {
  const l = e.level;
  switch (e.kind) {
    case 'formed': {
      const da = l.playType === 'da', inst = instrument(l.pair);
      const bias = l.external.dir === l.dir
        ? (l.internal.dir === l.dir ? '✅ aligned' : '✅ aligned (pullback: 1 BOS against)')
        : da ? '↩️ against (DA play, 1 BOS)' : l.imb ? '↩️ against (imbalance play, 1 BOS)'
          : l.choch ? '↩️ against (change of character, 1 BOS)' : '↩️ against (2 BOS rule met)';
      const side = l.dir === 'bull' ? 'bullish' : 'bearish', against = l.htfAgainst;
      const rr = l.imb ? Math.round((Math.abs(l.setup.tp - l.level) / Math.abs(l.level - l.setup.stop)) * 10) / 10 : null;
      // Bard's checks: pre-entry when the no-wick is low in its leg, a higher-timeframe no-wick against, NY open.
      const checks = [
        ...(l.leg && l.leg.pos < 0.5 ? [`📍 Pre-entry: the no-wick sits near the start of its leg (${Math.round(l.leg.pos * 100)}%). Bard enters early here, around ${l.leg.price} (50% of the leg)`] : []),
        ...(against ? [`⚠️ Untapped ${TF_LABEL[against.tf]} ${against.dir === 'bull' ? 'bullish' : 'bearish'} no-wick against this trade (${clock(against.time)} candle, at ${against.level}): it can play out first`] : []),
        ...(l.nyOpen && !aPlus(l) ? ['⚠️ New York open: Bard only takes A+ setups here'] : []),
      ];
      const news = [
        ...(ctx.upcoming ?? []).map((n) => `• ${esc(n.country)} ${esc(n.title)} at ${clock(n.t)}`),
        ...(ctx.newsUnavailable ? ['• News check unavailable — check the calendar yourself'] : []),
      ];
      return blocks(
        [`${dot(l.dir)} ${title(l)}${da ? ' · DA PLAY (experimental)' : ''}${l.imb ? ' · 🌀 IMBALANCE PLAY' : ''}`,
          `${side[0].toUpperCase()}${side.slice(1)} no-wick · ${clock(l.candleOpen)} candle`,
          ...(da ? [`Held the decision area ${l.daZone.lo}–${l.daZone.hi}`] : []),
          ...(l.imb ? [`🌀 Unfilled imbalance right ahead at ${l.imb.from}–${l.imb.to}: TP at its far edge (${l.setup.tp}, ${rr}R)`] : []),
          ...(l.choch ? [`🔄 Change of character setup: first ${TF_LABEL[inst.tf]} BOS against the ${TF_LABEL[inst.ext]}`] : [])].join('\n'),
        checks.join('\n'),
        block('📊 <b>Trend</b>', [`${TF_LABEL[inst.tf]}: ${trend(l.internal)}`, `${TF_LABEL[inst.ext]}: ${trend(l.external)} ${bias}`]),
        `🕒 ${esc(l.session)} session · tap window closes ${clock(l.deadline)}`,
        notes(l),
        block('📅 <b>News</b>', news),
      );
    }
    case 'upgrade':
      return blocks(
        `🔼 ${title(l)} · upgraded\nThe ${TF_LABEL[l.tf]} candle is a no-wick too · ${clock(l.candleOpen)} candle`,
        notes(l),
        `🕒 Tap window now closes ${clock(l.deadline)}`,
      );
    case 'tap':
      return `🎯 ${title(l)} · tapped\n${clock(e.time)} · candle ${l.tapIndex}/${config.tapWindowCandles}`;
    case 'result':
      if (e.outcome === 'closed') return `⏹ ${title(l)} · closed for the day (${l.closedR > 0 ? '+' : ''}${l.closedR}R)\n${clock(e.time)}`;
      return `${e.outcome === 'won' ? '✅' : '❌'} ${title(l)} · ${e.outcome === 'won' ? 'TP hit (+1R)' : 'stopped out (−1R)'}\n${clock(e.time)}`;
    case 'invalid': {
      const i = instrument(l.pair), near = +((config.nearMissPips * i.unit) / i.pip).toFixed(1);
      return `🚫 ${title(l)} · no longer valid\nCame within ${near} ${i.name} of the no-wick without tapping, then reached TP · ${clock(e.time)}`;
    }
    case 'be': {
      const b = l.beSignal, toStop = b.mode === 'stop';
      return `🛡️ ${title(l)} · no-wick against you\nAt ${b.at} · ${clock(e.time)}\n\n`
        + (toStop ? `In profit → move your stop to break-even (${l.level}).` : `In drawdown → move your TP to break-even (${l.level}).`);
    }
    case 'gap':
      return `⚠️ <b>${esc(name(e.pair))}: data gap</b> ${fmtTime(e.from)} → ${fmtTime(e.to)}. ${e.count} live level(s) marked unknown.`;
    case 'warning':
    case 'checkin':
    case 'recap':
      return e.text;
    default:
      return esc(JSON.stringify(e));
  }
}

// One-tap reporting under a trade's formation and result messages. A press sends "r:<num>:<outcome>"
// to the bot, which reads it on its next run (up to 5 min later), same as a typed "#05TP".
export function buttons(e) {
  const l = e.level;
  if (!['formed', 'result'].includes(e.kind) || !l?.num || silent(l)) return undefined;
  const b = (text, outcome) => ({ text, callback_data: `r:${l.num}:${outcome}` });
  return { inline_keyboard: [[b('✅ TP', 'TP'), b('❌ SL', 'SL'), b('➖ BE', 'BE')], [b('👀 Took it', 'TAKEN'), b('🚫 Invalid', 'INVALID')]] };
}

export class TelegramError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 200 → sent. 429 → wait and retry. 5xx → one retry then throw. Other 4xx → permanent.
export async function sendMessage(text, { token, chatId, fetchFn = fetch, html = true, wait = sleep, markup }) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true, ...(html ? { parse_mode: 'HTML' } : {}), ...(markup ? { reply_markup: markup } : {}) };
  let serverErrors = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) {
      if (++serverErrors > 1) throw new TelegramError(`Telegram unreachable: ${e?.name ?? 'network error'}`);
      continue;
    }
    if (res.ok) return 'sent';
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) { await wait(((data.parameters?.retry_after ?? 1) + 0.5) * 1000); continue; }
    if (res.status >= 500) { if (++serverErrors > 1) throw new TelegramError(`Telegram ${res.status}`); continue; }
    const why = `Telegram ${res.status}: ${String(data.description ?? '').slice(0, 120)}`;
    // Bad token, unknown chat or blocked bot is a setup problem: fail the run and keep the alerts queued.
    if ([401, 403, 404].includes(res.status) || /chat not found/i.test(why)) {
      throw new TelegramError(`${why}. Check the TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets.`);
    }
    return { permanent: why };
  }
  throw new TelegramError('Telegram kept rate-limiting');
}

// Queues an alert once. Undelivered messages stay in the outbox across runs until sent.
export function enqueue(state, id, text, markup) {
  if (state.sent[id] || state.failed[id] || state.outbox.some((m) => m.id === id)) return;
  state.outbox.push({ id, text, ...(markup ? { markup } : {}) });
}

// Sends the outbox in order, recording each success as it happens so a throw keeps progress.
export async function deliver(state, opts) {
  while (state.outbox.length) {
    const m = state.outbox[0];
    const result = await sendMessage(m.text, { ...opts, markup: m.markup });
    state.outbox.shift();
    if (result === 'sent') { state.sent[m.id] = opts.now; continue; }
    state.failed[m.id] = opts.now;
    opts.log?.(`Telegram refused ${m.id}: ${result.permanent}`);
    await sendMessage(`An alert could not be delivered (${result.permanent}). ID: ${m.id}`, { ...opts, html: false }).catch(() => {});
  }
}
