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
const head = (l) => `${tag(l.num) ? `${tag(l.num)} ` : ''}${esc(name(l.pair))}`;
const side = (dir) => (dir === 'bull' ? 'BUY' : 'SELL');
const trend = (t) => (t.dir ? `${t.dir === 'bull' ? 'bullish' : 'bearish'} (${t.count} BOS)` : 'unclear');

function setupLines(l) {
  const s = l.setup;
  return [
    `Entry: <b>${s.entry}</b> (limit at the no-wick open)`,
    `Stop: ${s.stop} (structure)${s.altStop !== null ? ` · alt ${s.altStop} (prev candle)` : ''}`,
    `TP: ${s.tp} (1:1) · Risk ${s.riskPips} pips`,
  ];
}

export function formatEvent(e, ctx = {}) {
  const l = e.level;
  switch (e.kind) {
    case 'formed': {
      const lines = [
        `🟡 <b>${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)}</b> — ${l.dir === 'bull' ? 'bullish' : 'bearish'} no-wick`,
        ...setupLines(l),
        `15m trend: ${trend(l.internal)} · 4H: ${trend(l.external)}${l.external.dir === l.dir ? ' (aligned)' : ' (against, 2 BOS rule met)'}`,
        `Session: ${esc(l.session)}`,
        `Tap window closes: ${fmtTime(l.deadline)}`,
      ];
      for (const w of l.setup.warnings) lines.push(`⚠️ ${esc(w)}`);
      for (const n of ctx.upcoming ?? []) lines.push(`📅 ${esc(n.country)} ${esc(n.title)} at ${fmtTime(n.t)}`);
      if (ctx.newsUnavailable) lines.push('📅 News check unavailable — check the calendar yourself');
      if (l.num) lines.push(`When your trade closes, reply <b>${tag(l.num)}TP</b> or <b>${tag(l.num)}SL</b>`);
      return lines.join('\n');
    }
    case 'upgrade':
      return [
        `🔼 <b>${head(l)} ${side(l.dir)} upgraded to ${TF_LABEL[l.tf]}</b> (level ${l.level})`,
        ...setupLines(l),
        ...l.setup.warnings.map((w) => `⚠️ ${esc(w)}`),
        `Tap window now closes: ${fmtTime(l.deadline)}`,
      ].join('\n');
    case 'tap':
      return `🎯 <b>${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)} tapped</b> at ${fmtTime(e.time)} (${l.tapIndex}/${config.tapWindowCandles})\n`
        + `Entry ${l.setup.entry} · Stop ${l.setup.stop} · TP ${l.setup.tp}`;
    case 'result':
      return `${e.outcome === 'won' ? '✅' : '❌'} <b>${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)}: ${e.outcome === 'won' ? 'TP hit, +1R' : 'stopped out, −1R'}</b> at ${fmtTime(e.time)}`;
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
