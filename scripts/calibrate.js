// Prints the bot's recent no-wicks and BOS calls in SAST, to compare against your TradingView chart.
// Usage: node scripts/calibrate.js [AUDUSD|GBPUSD] [days=2]
import { config, TF } from '../src/config.js';
import { fetchCandles, credentialsFromEnv } from '../src/candles.js';
import { analyze } from '../src/structure.js';
import { processPair } from '../src/run.js';
import { refreshNews } from '../src/filters.js';
import { freshState } from '../src/state.js';
import { fmtTime } from '../src/telegram.js';

const pair = `OANDA:${(process.argv[2] ?? 'AUDUSD').toUpperCase()}`;
const days = Number(process.argv[3] ?? 2);
const now = Math.floor(Date.now() / 1000);
const from = now - days * 86400;
const credentials = credentialsFromEnv();
const get = (tf) => fetchCandles({ pair, tf, count: 500, now, credentials });

const [m15, m30, h1, h4] = [await get(TF.M15), await get(TF.M30), await get(TF.H1), await get(TF.H4)];
const news = await refreshNews(null, now);

const state = freshState();
state.pairs[pair] = { last1m: now, last15: Math.floor(from / TF.M15) * TF.M15 }; // formations only, no tap replay
const { events, skipped } = processPair(state, pair, { m1: [], m15, m30, h1, h4 }, now, news);

console.log(`\n${pair} — last ${days} day(s), times in SAST${news.ok ? '' : ' (news calendar unavailable)'}\n`);
console.log('No-wicks the bot would alert on:');
for (const e of events) {
  const l = e.level;
  const tag = e.kind === 'upgrade' ? `  ↳ upgraded to ${l.tf / 60}m` : `  ${fmtTime(l.candleOpen)} ${l.dir.toUpperCase()} @ ${l.level}`;
  console.log(`${tag}  stop ${l.setup.stop} tp ${l.setup.tp}${l.setup.warnings.length ? `  [${l.setup.warnings.length} warning(s)]` : ''}`);
}
console.log('\nNo-wicks skipped:');
for (const s of skipped) console.log(`  ${fmtTime(s.time - TF.M15)} ${s.dir.toUpperCase()} @ ${s.level} — ${s.reason}`);

const show = (label, list, tf) => {
  console.log(`\n${label} BOS events:`);
  for (const b of analyze(list, tf).bos.filter((x) => x.time >= from)) console.log(`  ${fmtTime(b.time)} ${b.dir.toUpperCase()} (broke ${b.swing.type} ${b.swing.level})`);
};
show('15m', m15, TF.M15);
show('4H', h4, TF.H4);
