import { config, TF, TF_LABEL, instrument } from './config.js';
import { localParts } from './filters.js';
import { tag, esc, clock } from './telegram.js';
import { silent, TESTS } from './lifecycle.js';
import { quoteFor } from './quotes.js';

export function checkinDue(state, now) {
  const p = localParts(now, config.displayZone);
  return p.minutes >= config.checkinHourLocal * 60 && state.lastCheckin !== p.date ? p.date : null;
}

const word = (d) => ({ bull: 'bullish', bear: 'bearish' }[d] ?? 'unclear');
const short = (t) => (t.dir ? `${t.dir} ×${t.count}` : 'unclear');

// What the 1H and 4H imply for today. Alerts follow each pair's external trend (4H, or 1H for GER40).
export function dayBias({ ext, h1, h4 }) {
  if (h1.dir && h1.dir === h4.dir) return h1.dir === 'bull' ? ['🟢', 'bullish · favour buys'] : ['🔴', 'bearish · favour sells'];
  const [e, o, eL, oL] = ext === TF.H1 ? [h1, h4, '1H', '4H'] : [h4, h1, '4H', '1H'];
  if (!e.dir) return ['⚪', `unclear · wait for ${eL} structure`];
  return ['🟡', `mixed · ${eL} ${word(e.dir)}, ${oL} ${word(o.dir)}: ${e.dir === 'bull' ? 'buys' : 'sells'} follow the ${eL}, expect pullbacks`];
}

// Currencies that every forex pair agrees on, from the 4H: "USD strong (AUDUSD, GBPUSD)". Needs 2+ pairs.
// trends[].fx: [base, quote] for forex pairs, null for indices and crypto.
export function currencyTheme(trends) {
  const votes = new Map();
  for (const t of trends) {
    if (t.error || !t.fx || !t.h4.dir) continue;
    const s = t.h4.dir === 'bull' ? 1 : -1;
    for (const [c, v] of [[t.fx[0], s], [t.fx[1], -s]]) votes.set(c, [...(votes.get(c) ?? []), { v, name: t.name }]);
  }
  return [...votes].filter(([, vs]) => vs.length >= 2 && vs.every((x) => x.v === vs[0].v))
    .map(([c, vs]) => `${c} ${vs[0].v > 0 ? 'strong' : 'weak'} (${vs.map((x) => x.name).join(', ')})`);
}

// Briefing lines from the last 14 days of alerts: the weakest and strongest groups, and a losing streak.
// Results are yours where you reported, otherwise the bot's 1:1 tracking.
export function personalTips(levels, now) {
  const done = levels.filter((l) => !silent(l) && !l.playType && l.formedClose > now - 14 * 86400)
    .map((l) => ({ l, o: outcomeOf(l) ?? { won: 'TP', lost: 'SL' }[l.status] })).filter((x) => x.o === 'TP' || x.o === 'SL');
  const groups = new Map();
  const add = (key, x) => { const g = groups.get(key) ?? { w: 0, n: 0 }; g.n++; if (x.o === 'TP') g.w++; groups.set(key, g); };
  for (const x of done) {
    const { l } = x, kind = l.choch ? 'CHoCH' : l.internal?.dir === l.dir && l.external?.dir === l.dir ? 'A+'
      : l.external?.dir === l.dir ? 'Pullback' : 'Against-the-trend';
    add(`${l.session} session`, x); add(l.pair.split(':').pop(), x); add(kind, x);
  }
  const tips = [];
  for (const [key, g] of groups) {
    if (g.n < 5) continue;
    if (g.w / g.n <= 0.35) tips.push(`Last 2 weeks, ${key} alerts went ${g.w}W/${g.n - g.w}L. Be extra picky there today.`);
    if (g.w / g.n >= 0.7) tips.push(`Last 2 weeks, ${key} alerts went ${g.w}W/${g.n - g.w}L. That's where the edge is: be sharp.`);
  }
  const yours = levels.filter((l) => l.reported === 'TP' || l.reported === 'SL').sort((a, b) => b.reportedAt - a.reportedAt);
  if (yours.length >= 2 && yours[0].reported === 'SL' && yours[1].reported === 'SL') tips.push('Your last two reported trades were losses. One A+ setup at a time today, or smaller size.');
  return tips;
}

// The 05:00 SAST message on market days. trends: [{ name, ext, h1, h4, fx }] or [{ name, error }].
export function briefingText({ date, now, trends, news, dataAgeSec, tips = [] }) {
  const q = quoteFor(date), day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const lines = ['👋 <b>Hello, sir.</b>', q.by ? `💭 <i>“${esc(q.text)}”</i> — ${esc(q.by)}` : `🧠 <i>${esc(q.text)}</i>`,
    ...(tips.length ? [`📒 ${esc(tips[day % tips.length])}`] : []), '', "📊 <b>Today's bias</b>"];
  for (const t of trends) {
    if (t.error) { lines.push(`⚠️ <b>${t.name}</b> data unavailable`); continue; }
    const [icon, text] = dayBias(t);
    lines.push(`${icon} <b>${t.name}</b> ${text}`, `      1H ${short(t.h1)} · 4H ${short(t.h4)}`);
  }
  const theme = currencyTheme(trends);
  if (theme.length) lines.push('', `💱 <b>Theme</b> (4H): ${theme.join(' · ')}. Trades on these pairs are one bet.`);
  const mine = new Set(config.pairs.flatMap((p) => instrument(p).currencies));
  const onDate = (e) => mine.has(e.country) && localParts(e.t, config.displayZone).date === date;
  const events = news?.events ?? [], holidays = events.filter((e) => e.holiday && onDate(e));
  const today = events.filter((e) => !e.holiday && e.t >= now && onDate(e)).sort((a, b) => a.t - b.t);
  lines.push('', '📅 <b>High-impact news today</b>',
    ...[...new Set(holidays.map((e) => e.country))].map((c) => `🏖 ${esc(c)} bank holiday: thin liquidity, expect fake moves and wider spreads.`),
    ...today.map((e) => `• ${clock(e.t).slice(4)} ${esc(e.country)} ${esc(e.title)}`));
  if (!news?.ok) lines.push('News calendar unavailable — check it yourself.');
  else if (!today.length && !holidays.length) lines.push('None for your pairs.');
  lines.push('', `🤖 Bot running · latest data ${Number.isFinite(dataAgeSec) ? `${Math.round(dataAgeSec / 60)} min old` : 'not fetched this run'}`);
  return lines.join('\n');
}

// Win rate counts only wins and losses; unknown and muted are listed separately.
export function recapStats(results) {
  const groups = new Map();
  const add = (key, r) => {
    const g = groups.get(key) ?? { won: 0, lost: 0, closed: 0, unknown: 0, muted: 0 };
    g[r.outcome]++;
    groups.set(key, g);
  };
  for (const r of results) { add('All', r); add(`${r.pair.split(':').pop()} ${TF_LABEL[r.tf]}`, r); }
  const rate = (g) => (g.won + g.lost ? Math.round((100 * g.won) / (g.won + g.lost)) : null);
  return [...groups].map(([key, g]) => ({ key, ...g, rate: rate(g) }));
}

// What you reported; "Took it" without a reported close uses the bot's own result.
export const outcomeOf = (l) => (l.reported === 'TAKEN' ? { won: 'TP', lost: 'SL' }[l.status] ?? null : l.reported);

function yourTrades(lines, label, reported) {
  const n = (o) => reported.filter((l) => outcomeOf(l) === o).length;
  const tp = n('TP'), sl = n('SL'), be = n('BE');
  // Win rate counts TP vs SL only; break-evens are listed but neither win nor loss.
  const rate = tp + sl ? ` (${Math.round((100 * tp) / (tp + sl))}%)` : '';
  lines.push(`<b>${label}</b>: ${tp} TP / ${sl} SL${be ? ` / ${be} B/E` : ''}${rate}`);
  for (const l of [...reported].sort((a, b) => a.num - b.num)) {
    lines.push(`${{ TP: '✅', SL: '❌', BE: '➖' }[outcomeOf(l)] ?? '❔'} ${tag(l.num)} ${l.pair.split(':').pop()} ${TF_LABEL[l.tf]} ${l.dir === 'bull' ? 'BUY' : 'SELL'}`);
  }
}

const statLine = (g) => `${g.key}: ${g.won}W / ${g.lost}L${g.rate !== null ? ` (${g.rate}%)` : ''}`
  + `${g.closed ? ` · ${g.closed} closed for the day` : ''}${g.unknown ? ` · ${g.unknown} unknown` : ''}${g.muted ? ` · ${g.muted} muted by news` : ''}`;

// da: experimental DA plays, kept out of the main numbers: { alerts, reported, results }.
export function recapText(results, alertCount, reported = [], da = null) {
  const lines = [`📊 <b>Weekly recap</b> — ${alertCount} setup alert(s)`];
  if (reported.length) {
    lines.push('');
    yourTrades(lines, 'Your trades', reported);
    lines.push('', '<b>Bot tracking</b> (exact 1:1 levels):');
  }
  for (const g of recapStats(results)) lines.push(statLine(g));
  if (!results.length) lines.push('No tapped trades this week.');
  if (da && (da.alerts || da.results.length)) {
    lines.push('', `🧪 <b>DA plays (experimental)</b> — ${da.alerts} alert(s), not counted above`);
    if (da.reported.length) yourTrades(lines, 'Your DA trades', da.reported);
    for (const g of recapStats(da.results)) lines.push(statLine(g));
    if (!da.results.length) lines.push('No tapped DA plays this week.');
  }
  return lines.join('\n');
}

const pairName = (p) => p.split(':').pop();
const pct = (w, l) => (w + l ? ` (${Math.round((100 * w) / (w + l))}%)` : '');

// "3 TP / 1 SL / 1 B/E (75%)" for trades you reported.
function tally(levels) {
  const n = (o) => levels.filter((l) => outcomeOf(l) === o).length;
  const tp = n('TP'), sl = n('SL'), be = n('BE');
  return `${tp} TP / ${sl} SL${be ? ` / ${be} B/E` : ''}${pct(tp, sl)}`;
}

function period(state, now, days, heading) {
  const since = now - days * 86400;
  const out = [`<b>${heading}</b>`];
  for (const [label, play] of [['', null], ['🧪 DA plays: ', 'da']]) {
    const mine = state.levels.filter((l) => !l.shadow && l.reported && (l.playType ?? null) === play && l.formedClose > since);
    const bot = state.results.filter((r) => !r.shadow && (r.play ?? null) === play && r.closed > since);
    if (play && !mine.length && !bot.length) continue;
    out.push(`${label ? `${label}\n` : ''}You: ${mine.length ? tally(mine) : 'nothing reported'}`);
    const pairs = [...new Set(mine.map((l) => l.pair))].sort();
    if (pairs.length > 1) for (const p of pairs) out.push(`  • ${pairName(p)}: ${tally(mine.filter((l) => l.pair === p))}`);
    const won = bot.filter((r) => r.outcome === 'won').length, lost = bot.filter((r) => r.outcome === 'lost').length;
    out.push(`Bot (exact 1:1): ${won}W / ${lost}L${pct(won, lost)}`);
  }
  return out.join('\n');
}

// Reply to /stats: your reported trades and the bot's own tracking, last 7 and 30 days.
export function statsText(state, now) {
  const live = (s) => state.levels.filter((l) => !silent(l) && l.status === s).length;
  return [
    '📊 <b>Stats</b>',
    period(state, now, 7, 'Last 7 days'),
    period(state, now, 30, 'Last 30 days'),
    `🟡 ${live('active')} alert(s) waiting for a tap · ${live('tracking')} running`,
  ].join('\n\n');
}

// Weekly recap section: the same alerted trades under other rules, in R. Fills up as trades finish.
export function testsText(state, now, days = 30) {
  const since = now - days * 86400, R = { won: 1, lost: -1 };
  const base = state.results.filter((r) => !r.shadow && !r.play && r.closed > since && ['won', 'lost', 'closed'].includes(r.outcome));
  if (!base.length) return '';
  const rOf = (r) => (r.outcome === 'closed' ? r.r : r.outcome === 'won' ? r.rr ?? 1 : R[r.outcome]), byId = new Map(base.map((r) => [r.id, rOf(r)]));
  const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 10) / 10, fmt = (x) => `${x > 0 ? '+' : ''}${x}R`;
  const arrow = (a, b) => (a > b ? '⬆️' : a < b ? '⬇️' : '➖');
  const now1 = base.map(rOf), w = now1.filter((x) => x > 0).length;
  const lines = [`🧪 <b>Rule tests</b> (last ${days} days)`, `Now, exact 1:1: ${base.length} trades · ${w}W/${now1.filter((x) => x < 0).length}L · ${fmt(sum(now1))}`];
  const vs = (label, pairs) => { // pairs: [testR, nowR] for the same trades
    if (!pairs.length) return;
    const a = sum(pairs.map((p) => p[0])), b = sum(pairs.map((p) => p[1]));
    lines.push(`${arrow(a, b)} ${label}: ${fmt(a)} vs ${fmt(b)} (${pairs.length} trades)`);
  };
  for (const [k, label] of Object.entries(TESTS)) vs(label, (state.tests ?? []).filter((t) => t.test === k && byId.has(t.id)).map((t) => [t.r, byId.get(t.id)]));
  const M = { TP: 1, SL: -1, BE: 0 };
  vs('Following the BE rule', base.filter((r) => r.managed in M || (r.managed === 'closed' && r.outcome === 'closed')).map((r) => [M[r.managed] ?? r.r, rOf(r)]));
  const subset = (label, keep) => {
    const known = base.filter((r) => r.aplus !== undefined), kept = known.filter(keep);
    if (known.length) lines.push(`${arrow(sum(kept.map(rOf)), sum(known.map(rOf)))} ${label}: ${fmt(sum(kept.map(rOf)))} from ${kept.length} of ${known.length} trades`);
  };
  subset('Only A+ alerts', (r) => r.aplus);
  subset('Without pullback alerts', (r) => !r.pullback);
  // Pullbacks stopped alerting on 2026-11-26 (not Bard's rule, except GER40); they are still tracked silently.
  const skipped = state.results.filter((r) => r.shadow && r.skip?.startsWith('pullback') && r.closed > since && ['won', 'lost', 'closed'].includes(r.outcome));
  if (skipped.length) {
    const rs = skipped.map(rOf);
    lines.push(`⏭ Skipped pullbacks would have made ${fmt(sum(rs))} (${rs.filter((x) => x > 0).length}W/${rs.filter((x) => x < 0).length}L)`);
  }
  return lines.join('\n');
}
