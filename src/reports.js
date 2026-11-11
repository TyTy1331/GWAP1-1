import { config, TF_LABEL } from './config.js';
import { localParts } from './filters.js';
import { tag } from './telegram.js';
import { silent } from './lifecycle.js';

export function checkinDue(state, now) {
  const p = localParts(now, config.displayZone);
  return p.minutes >= config.checkinHourLocal * 60 && state.lastCheckin !== p.date ? p.date : null;
}

export function checkinText(state, now, dataAgeSec) {
  const active = state.levels.filter((l) => !silent(l) && l.status === 'active').length;
  const open = state.levels.filter((l) => !silent(l) && l.status === 'tracking').length;
  return `🤖 No-wick bot running. ${active} active level(s), ${open} open trade(s). Latest data ${Number.isFinite(dataAgeSec) ? `${Math.round(dataAgeSec / 60)} min old` : "not fetched this run"}.`;
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

function yourTrades(lines, label, reported) {
  const n = (o) => reported.filter((l) => l.reported === o).length;
  const tp = n('TP'), sl = n('SL'), be = n('BE');
  // Win rate counts TP vs SL only; break-evens are listed but neither win nor loss.
  const rate = tp + sl ? ` (${Math.round((100 * tp) / (tp + sl))}%)` : '';
  lines.push(`<b>${label}</b>: ${tp} TP / ${sl} SL${be ? ` / ${be} B/E` : ''}${rate}`);
  for (const l of [...reported].sort((a, b) => a.num - b.num)) {
    lines.push(`${{ TP: '✅', SL: '❌', BE: '➖' }[l.reported] ?? '❔'} ${tag(l.num)} ${l.pair.split(':').pop()} ${TF_LABEL[l.tf]} ${l.dir === 'bull' ? 'BUY' : 'SELL'}`);
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
  const n = (o) => levels.filter((l) => l.reported === o).length;
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
