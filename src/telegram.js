import { config, TF_LABEL } from './config.js';
import { localParts } from './filters.js';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fmtTime(t) {
  const p = localParts(t, config.displayZone);
  const hh = String(Math.floor(p.minutes / 60)).padStart(2, '0'), mm = String(p.minutes % 60).padStart(2, '0');
  return `${p.weekday} ${p.date.slice(5)} ${hh}:${mm} SAST`;
}

const name = (pair) => pair.split(':').pop();
export const tag = (num) => (num ? `#${String(num).padStart(2, '0')}` : '');
const head = (l) => `${tag(l.num) ? `${tag(l.num)} ` : ''}${esc(name(l.pair))}${l.playType === 'da' ? ' 🧪' : ''}`;
const side = (dir) => (dir === 'bull' ? 'BUY' : 'SELL');
const trend = (t) => (t.dir ? `${t.dir === 'bull' ? 'bullish' : 'bearish'} (${t.count} BOS)` : 'unclear');

// Several voids would flood the alert, so they become one line: how many, their average level and full span.
export function warnLines(warnings) {
  const voids = [], rest = [];
  for (const w of warnings) {
    const m = /^Unfilled void against the trade at ([\d.]+)–([\d.]+)$/.exec(w);
    if (m) voids.push([m[1], m[2]]); else rest.push(w);
  }
  if (voids.length > 1) {
    const dp = Math.max(...voids.flat().map((x) => x.split('.')[1]?.length ?? 0));
    const nums = voids.flat().map(Number);
    const avg = (voids.reduce((a, [f, t]) => a + (+f + +t) / 2, 0) / voids.length).toFixed(dp);
    rest.unshift(`${voids.length} unfilled voids against the trade, averaging ${avg} (${Math.min(...nums)}–${Math.max(...nums)})`);
  } else if (voids.length) rest.unshift(`Unfilled void against the trade at ${voids[0][0]}–${voids[0][1]}`);
  return rest.map((w) => `⚠️ ${esc(w)}`);
}

// Alerts name the trade and its confluences only; entry, stop and TP are the trader's call.
export function formatEvent(e, ctx = {}) {
  const l = e.level;
  switch (e.kind) {
    case 'formed': {
      const da = l.playType === 'da';
      const lines = [
        da ? `🧪 <b>DA PLAY (experimental) — ${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)}</b>`
          : `🟡 <b>${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)}</b> — ${l.dir === 'bull' ? 'bullish' : 'bearish'} no-wick`,
        ...(da ? [`Counter-trend ${l.dir === 'bull' ? 'bullish' : 'bearish'} no-wick after price held the decision area ${l.daZone.lo}–${l.daZone.hi}`] : []),
        `15m trend: ${trend(l.internal)} · 4H: ${trend(l.external)}${l.external.dir === l.dir ? (l.internal.dir === l.dir ? ' (aligned)' : ' (aligned — 1 BOS against = pullback)') : da ? ' (against — DA play, 1 BOS)' : ' (against, 2 BOS rule met)'}`,
        `Session: ${esc(l.session)}`,
        `Tap window closes: ${fmtTime(l.deadline)}`,
      ];
      lines.push(...warnLines(l.setup.warnings));
      for (const n of l.setup.notes ?? []) lines.push(`ℹ️ ${esc(n)}`);
      for (const n of ctx.upcoming ?? []) lines.push(`📅 ${esc(n.country)} ${esc(n.title)} at ${fmtTime(n.t)}`);
      if (ctx.newsUnavailable) lines.push('📅 News check unavailable — check the calendar yourself');
      if (l.num) lines.push(`When your trade closes, reply <b>${tag(l.num)}TP</b>, <b>${tag(l.num)}SL</b> or <b>${tag(l.num)}BE</b>`);
      return lines.join('\n');
    }
    case 'upgrade':
      return [
        `🔼 <b>${head(l)} ${side(l.dir)} upgraded to ${TF_LABEL[l.tf]}</b>`,
        ...warnLines(l.setup.warnings),
        ...(l.setup.notes ?? []).map((n) => `ℹ️ ${esc(n)}`),
        `Tap window now closes: ${fmtTime(l.deadline)}`,
      ].join('\n');
    case 'tap':
      return `🎯 <b>${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)} tapped</b> at ${fmtTime(e.time)} (${l.tapIndex}/${config.tapWindowCandles})`;
    case 'result':
      return `${e.outcome === 'won' ? '✅' : '❌'} <b>${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)}: ${e.outcome === 'won' ? 'TP hit, +1R' : 'stopped out, −1R'}</b> at ${fmtTime(e.time)}`;
    case 'be': {
      const b = l.beSignal, toStop = b.mode === 'stop';
      return `🛡️ <b>${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)}: no-wick against you</b> at ${b.at} (${fmtTime(e.time)})\n`
        + (toStop ? `Trade is in profit → move your stop to break-even (${l.level}).` : `Trade is in drawdown → move your TP to break-even (${l.level}).`);
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

export class TelegramError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 200 → sent. 429 → wait and retry. 5xx → one retry then throw. Other 4xx → permanent.
export async function sendMessage(text, { token, chatId, fetchFn = fetch, html = true, wait = sleep }) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true, ...(html ? { parse_mode: 'HTML' } : {}) };
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
export function enqueue(state, id, text) {
  if (state.sent[id] || state.failed[id] || state.outbox.some((m) => m.id === id)) return;
  state.outbox.push({ id, text });
}

// Sends the outbox in order, recording each success as it happens so a throw keeps progress.
export async function deliver(state, opts) {
  while (state.outbox.length) {
    const m = state.outbox[0];
    const result = await sendMessage(m.text, opts);
    state.outbox.shift();
    if (result === 'sent') { state.sent[m.id] = opts.now; continue; }
    state.failed[m.id] = opts.now;
    opts.log?.(`Telegram refused ${m.id}: ${result.permanent}`);
    await sendMessage(`An alert could not be delivered (${result.permanent}). ID: ${m.id}`, { ...opts, html: false }).catch(() => {});
  }
}
