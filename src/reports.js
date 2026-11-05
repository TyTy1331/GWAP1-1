import { config, TF_LABEL } from './config.js';
import { localParts } from './filters.js';
import { tag } from './telegram.js';

export function checkinDue(state, now) {
  const p = localParts(now, config.displayZone);
  return p.minutes >= config.checkinHourLocal * 60 && state.lastCheckin !== p.date ? p.date : null;
}

export function checkinText(state, now, dataAgeSec) {
  const active = state.levels.filter((l) => !l.shadow && l.status === 'active').length;
  const open = state.levels.filter((l) => !l.shadow && l.status === 'tracking').length;
  return `🤖 No-wick bot running. ${active} active level(s), ${open} open trade(s). Latest data ${Number.isFinite(dataAgeSec) ? `${Math.round(dataAgeSec / 60)} min old` : "not fetched this run"}.`;
}

// Win rate counts only wins and losses; unknown and muted are listed separately.
export function recapStats(results) {
  const groups = new Map();
  const add = (key, r) => {
    const g = groups.get(key) ?? { won: 0, lost: 0, unknown: 0, muted: 0 };
    g[r.outcome]++;
    groups.set(key, g);
  };
  for (const r of results) { add('All', r); add(`${r.pair.split(':').pop()} ${TF_LABEL[r.tf]}`, r); }
  const rate = (g) => (g.won + g.lost ? Math.round((100 * g.won) / (g.won + g.lost)) : null);
  return [...groups].map(([key, g]) => ({ key, ...g, rate: rate(g) }));
}

function yourTrades(lines, label, reported) {
  const tp = reported.filter((l) => l.reported === 'TP').length, sl = reported.length - tp;
  lines.push(`<b>${label}</b>: ${tp} TP / ${sl} SL (${Math.round((100 * tp) / reported.length)}%)`);
  for (const l of [...reported].sort((a, b) => a.num - b.num)) {
    lines.push(`${l.reported === 'TP' ? '✅' : '❌'} ${tag(l.num)} ${l.pair.split(':').pop()} ${TF_LABEL[l.tf]} ${l.dir === 'bull' ? 'BUY' : 'SELL'}`);
  }
}

const statLine = (g) => `${g.key}: ${g.won}W / ${g.lost}L${g.rate !== null ? ` (${g.rate}%)` : ''}`
  + `${g.unknown ? ` · ${g.unknown} unknown` : ''}${g.muted ? ` · ${g.muted} muted by news` : ''}`;

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
