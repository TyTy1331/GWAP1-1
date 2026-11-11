import { config, TF_LABEL } from './config.js';
import { localParts } from './filters.js';

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
const title = (l) => `<b>${head(l)} ${TF_LABEL[l.tf]} ${side(l.dir)}</b>`;

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
  return rest.map((w) => `• ${esc(w)}`);
}

// A titled block, or nothing when it has no lines. Blocks are separated by a blank line.
const block = (heading, lines) => (lines.length ? [heading, ...lines].join('\n') : '');
const blocks = (...b) => b.filter(Boolean).join('\n\n');
const cautions = (l) => block('⚠️ <b>Watch out</b>', warnLines(l.setup.warnings));
const notes = (l) => block('ℹ️ <b>Good to know</b>', (l.setup.notes ?? []).map((n) => `• ${esc(n)}`));

// Alerts name the trade and its confluences only; entry, stop and TP are the trader's call.
export function formatEvent(e, ctx = {}) {
  const l = e.level;
  switch (e.kind) {
    case 'formed': {
      const da = l.playType === 'da';
      const bias = l.external.dir === l.dir
        ? (l.internal.dir === l.dir ? '✅ aligned' : '✅ aligned (pullback: 1 BOS against)')
        : da ? '↩️ against (DA play, 1 BOS)' : '↩️ against (2 BOS rule met)';
      const news = [
        ...(ctx.upcoming ?? []).map((n) => `• ${esc(n.country)} ${esc(n.title)} at ${clock(n.t)}`),
        ...(ctx.newsUnavailable ? ['• News check unavailable — check the calendar yourself'] : []),
      ];
      return blocks(
        [`${dot(l.dir)} ${title(l)}${da ? ' · DA PLAY (experimental)' : ''}`,
          `${l.dir === 'bull' ? 'Bullish' : 'Bearish'} no-wick · ${clock(l.candleOpen)} candle`,
          ...(da ? [`Held the decision area ${l.daZone.lo}–${l.daZone.hi}`] : [])].join('\n'),
        block('📊 <b>Trend</b>', [`15m: ${trend(l.internal)}`, `4H: ${trend(l.external)} ${bias}`]),
        `🕒 ${esc(l.session)} session · tap window closes ${clock(l.deadline)}`,
        cautions(l),
        notes(l),
        block('📅 <b>News</b>', news),
      );
    }
    case 'upgrade':
      return blocks(
        `🔼 ${title(l)} · upgraded\nThe ${TF_LABEL[l.tf]} candle is a no-wick too · ${clock(l.candleOpen)} candle`,
        cautions(l),
        notes(l),
        `🕒 Tap window now closes ${clock(l.deadline)}`,
      );
    case 'tap':
      return `🎯 ${title(l)} · tapped\n${clock(e.time)} · candle ${l.tapIndex}/${config.tapWindowCandles}`;
    case 'result':
      if (e.outcome === 'closed') return `⏹ ${title(l)} · closed before market close (${l.closedR > 0 ? '+' : ''}${l.closedR}R)\n${clock(e.time)}`;
      return `${e.outcome === 'won' ? '✅' : '❌'} ${title(l)} · ${e.outcome === 'won' ? 'TP hit (+1R)' : 'stopped out (−1R)'}\n${clock(e.time)}`;
    case 'invalid':
      return `🚫 ${title(l)} · no longer valid\nCame within ${config.nearMissPips} pips of the no-wick without tapping, then reached TP · ${clock(e.time)}`;
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
