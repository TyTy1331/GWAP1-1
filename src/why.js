import { config, TF_LABEL, instrument } from './config.js';
import { localParts } from './filters.js';
import { esc, clock, tag } from './telegram.js';

const name = (pair) => pair.split(':').pop();
const trend = (t) => (t?.dir ? `${t.dir === 'bull' ? 'bullish' : 'bearish'} (${t.count} BOS)` : 'unclear');
const USAGE = 'Ask about a trade or a candle:\n<code>/why #175</code>\n<code>/why AUDJPY 13:15</code> (candle open time, SAST)';

// Which trend rule let the setup through, or stopped it. Mirrors isValid, the DA play and CHoCH.
function rule(l, inst) {
  const i = l.internal ?? {}, e = l.external ?? {}, iL = TF_LABEL[inst.tf], eL = TF_LABEL[inst.ext];
  if (inst.verdict) return `Valid only when the ${[inst.tf, inst.ext, inst.ext2].map((tf) => TF_LABEL[tf]).join(', ')} all point the trade's way.`;
  if (l.playType === 'da') return `DA play: 1 ${iL} BOS against the ${eL}, with a held decision area behind the entry.`;
  if (l.imb) return `Imbalance play: 1 ${iL} BOS against the ${eL}, with an unfilled imbalance right ahead (TP at its far edge).`;
  if (l.choch) return `Change of character: the first ${iL} BOS against the ${eL}, traded in the new direction.`;
  if (e.dir === l.dir) {
    if (i.dir === l.dir) return `Both trends agree (A+).`;
    if (i.dir && i.count === 1) {
      return inst.pullback ? `Pullback: the ${eL} agrees and the ${iL} has only 1 BOS against.`
        : `Pullback: the ${eL} agrees, but the ${iL} has 1 BOS against. Bard needs both to agree, so only GER40 alerts these.`;
    }
    return `The ${eL} agrees, but the ${iL} has ${i.count ?? 0} BOS against: more than a pullback.`;
  }
  const against = e.dir ? `Against the ${eL}` : `The ${eL} was unclear`;
  if (i.dir !== l.dir) return `${against}, and the ${iL} points the other way too.`;
  return i.count >= 2 ? `${against}, but the ${iL} has ${i.count} BOS in the trade's direction (2 needed).`
    : `${against}: needs 2 ${iL} BOS in the trade's direction, it had ${i.count}.`;
}

function skipText(reason) {
  const s = config.sessions.allowed;
  if (reason === 'outside session') return `outside trading hours (${s.at(-1).end}–${s[0].start} SAST is your no-trade zone).`;
  if (reason === 'red-folder news') return `high-impact news within ${config.newsMuteMinutes} min.`;
  if (reason === 'no opposite swing for a stop') return 'no swing on the other side to put a stop behind.';
  if (reason.startsWith('pullback')) return "a pullback, which isn't Bard's rule.";
  if (reason.startsWith('trend')) return 'the trend rules were not met.';
  return `${reason}.`;
}

function outcome(l) {
  // Lazy: each status has different fields set.
  const tap = l.tapTime ? `Tapped ${clock(l.tapTime)} (candle ${l.tapIndex}/${config.tapWindowCandles})` : '';
  const out = {
    active: () => `Waiting for a tap until ${clock(l.deadline)}.`,
    tracking: () => `${tap}, still running.`,
    won: () => `${tap}, then TP ✅ ${l.resultTime ? clock(l.resultTime) : ''}.`,
    lost: () => `${tap}, then stopped out ❌ ${l.resultTime ? clock(l.resultTime) : ''}.`,
    closed: () => `${tap}, closed for the day (${l.closedR}R).`,
    expired: () => `No tap within ${config.tapWindowCandles} candles: expired.`,
    unknown: () => 'Data gap: result unknown.',
    nosetup: () => 'No stop could be placed, so it was not tracked.',
  }[l.status]?.() ?? l.status;
  return [out, l.muted ? 'Muted by news.' : '', l.invalid ? `Marked invalid: ${l.invalid}.` : '', l.reported ? `You reported: ${l.reported}.` : '']
    .filter(Boolean).join(' ');
}

function explain(l) {
  const inst = instrument(l.pair);
  return [
    `🔎 <b>${tag(l.num) ? `${tag(l.num)} ` : ''}${esc(name(l.pair))} ${TF_LABEL[inst.tf]} ${l.dir === 'bull' ? 'BUY' : 'SELL'}</b> · ${clock(l.candleOpen)} candle`,
    inst.verdict ? (l.shadow ? `❌ Sent as not valid: ${String(l.skipReason).replace(/^not valid: /, '')}.` : '✅ Sent as valid')
      : l.shadow ? `⏭ Not alerted: ${skipText(l.skipReason ?? 'skipped')}` : '✅ Alerted',
    `📊 ${TF_LABEL[inst.tf]} ${trend(l.internal)} · ${TF_LABEL[inst.ext]} ${trend(l.external)}${inst.ext2 ? ` · ${TF_LABEL[inst.ext2]} ${trend(l.external2)}` : ''}`,
    `📏 ${rule(l, inst)}`,
    `🕒 Session: ${esc(l.session)}${l.upgrades.length ? ` · upgraded to ${l.upgrades.map((tf) => TF_LABEL[tf]).join(', ')}` : ''}`,
    `➡️ ${outcome(l)}`,
  ].join('\n');
}

// Reply to "/why #175" or "/why AUDJPY 13:15", from the levels kept for the last pruneDays days.
export function whyText(state, arg) {
  const text = String(arg ?? '').trim(), newest = (list) => list.sort((a, b) => b.candleOpen - a.candleOpen)[0];
  const byNum = /^#?(\d{1,4})$/.exec(text);
  if (byNum) {
    const l = newest(state.levels.filter((x) => x.num === Number(byNum[1])));
    return l ? explain(l) : `❓ No trade ${tag(Number(byNum[1]))} in the last ${config.pruneDays} days.`;
  }
  const m = /^([a-z0-9]+)\s+(\d{1,2})[:h.]?(\d{2})$/i.exec(text);
  if (!m) return USAGE;
  const pair = config.pairs.find((p) => name(p).toUpperCase() === m[1].toUpperCase());
  if (!pair) return `❓ I don't watch ${esc(m[1])}. Pairs: ${config.pairs.map(name).join(', ')}.`;
  const inst = instrument(pair), minutes = Number(m[2]) * 60 + Number(m[3]), step = inst.tf / 60;
  if (minutes % step) return `${name(pair)} ${TF_LABEL[inst.tf]} candles open every ${step} minutes (e.g. ${m[2].padStart(2, '0')}:${String(Number(m[3]) - (Number(m[3]) % step)).padStart(2, '0')}).`;
  const l = newest(state.levels.filter((x) => x.pair === pair && localParts(x.candleOpen, config.displayZone).minutes === minutes));
  if (l) return explain(l);
  return `🔎 No no-wick on ${name(pair)} ${TF_LABEL[inst.tf]} at ${m[2].padStart(2, '0')}:${m[3]} in the last ${config.pruneDays} days.\n`
    + `On the bot's data (${pair.split(':')[0]}) that candle had a wick on its open side, or the bot was not running then. Your broker's chart can differ by a pip.`;
}
