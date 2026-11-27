import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TF_LABEL } from './config.js';
import { fmtTime, tag } from './telegram.js';

// One row per no-wick, alerted or skipped, in monthly CSV files that are never deleted.
const COLUMNS = ['id', 'number', 'alerted', 'skip_reason', 'pair', 'timeframe', 'direction', 'formed_utc', 'formed_sast',
  'level', 'stop', 'alt_stop', 'tp', 'risk_pips', 'trend_15m', 'bos_15m', 'trend_4h', 'bos_4h', 'session', 'warnings',
  'upgrades', 'tap_utc', 'tap_n', 'bot_result', 'muted_by_news', 'result_utc', 'reported', 'reported_utc',
  'be_signal_utc', 'be_action', 'managed_result', 'play_type', 'da_below', 'da_above', 'range_pos', 'in_da', 'tp_beyond_da', 'invalid',
  'test_tp15_r', 'test_stop_2pips_r', 'test_stop_1pip_r', 'test_stop_3pips_r', 'test_prev_candle_stop_r',
  'pre_entry_leg_pos', 'htf_nowick_against', 'ny_open', 'trend_1d', 'bos_1d'];

const FINAL = new Set(['won', 'lost', 'closed', 'expired', 'unknown', 'nosetup']);
const RESULT = { won: 'TP', lost: 'SL', expired: 'expired', unknown: 'unknown', nosetup: 'no setup', tracking: 'open', active: 'open' };
const iso = (t) => (t ? new Date(t * 1000).toISOString().replace('.000Z', 'Z') : '');
const cell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const signature = (l) => `${l.status}|${l.reported ?? ''}|${l.upgrades.length}|${l.managedResult ?? ''}|${l.invalid ?? ''}|${Object.values(l.tests ?? {}).map((v) => v.r ?? '').join(':')}`;

export function journalRow(l) {
  const s = l.setup ?? {};
  return [
    l.id, l.num ? tag(l.num) : '', l.shadow ? 'no' : 'yes', l.skipReason ?? '', l.pair.split(':').pop(), TF_LABEL[l.tf],
    l.dir === 'bull' ? 'BUY' : 'SELL', iso(l.candleOpen), fmtTime(l.candleOpen), l.level, s.stop, s.altStop, s.tp, s.riskPips,
    l.internal?.dir ?? '', l.internal?.count ?? '', l.external?.dir ?? '', l.external?.count ?? '', l.session,
    (s.warnings ?? []).join('; '), l.upgrades.map((tf) => TF_LABEL[tf]).join(';'), iso(l.tapTime), l.tapIndex ?? '',
    l.status === 'closed' ? `closed for the day ${l.closedR}R` : RESULT[l.status] ?? l.status, l.muted ? 'yes' : '', iso(l.resultTime), l.reported ?? '', iso(l.reportedAt),
    iso(l.beSignal?.time), l.beSignal ? (l.beSignal.mode === 'stop' ? 'stop to BE' : 'TP to BE') : '', l.managedResult ?? '',
    l.playType ?? (l.imb ? 'imbalance' : l.choch ? 'choch' : 'normal'), s.da?.below, s.da?.above, s.da?.rangePos, s.da ? (s.da.inDA ? 'yes' : 'no') : '', s.da?.tpBeyond, l.invalid ?? '',
    l.tests?.tp15?.r ?? '', l.tests?.buf2?.r ?? '', l.tests?.buf1?.r ?? '', l.tests?.buf3?.r ?? '', l.tests?.prev?.r ?? '',
    l.leg?.pos ?? '', l.htfAgainst ? `${TF_LABEL[l.htfAgainst.tf]} ${l.htfAgainst.dir} ${l.htfAgainst.level}` : '', l.nyOpen ? 'yes' : '', l.external2?.dir ?? '', l.external2?.count ?? '',
  ].map(cell).join(',');
}

// Writes rows for setups that finished or were reported since the last sync. Rows are keyed by id,
// so a later change (e.g. your #05TP after the bot's result) updates the row in place.
export function syncJournal(state, dir) {
  const dirty = state.levels.filter((l) => (FINAL.has(l.status) || l.reported || l.invalid) && l.journaled !== signature(l));
  const byMonth = Map.groupBy(dirty, (l) => iso(l.candleOpen).slice(0, 7));
  for (const [month, levels] of byMonth) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${month}.csv`);
    const rows = new Map();
    if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) if (line) rows.set(line.slice(0, line.indexOf(',')), line);
    for (const l of levels) { rows.set(l.id, journalRow(l)); l.journaled = signature(l); }
    // sort by formation time (the id ends with <candle open>:<dir>)
    const sorted = [...rows.values()].sort((a, b) => Number(a.split(',')[0].split(':')[2]) - Number(b.split(',')[0].split(':')[2]));
    writeFileSync(file, `${COLUMNS.join(',')}\n${sorted.join('\n')}\n`);
  }
  return dirty.length;
}
