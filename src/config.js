// All tunable settings live here. Times are local market time in the given IANA zone.
export const TF = { M1: 60, M15: 900, M30: 1800, H1: 3600, H4: 14400 };
export const TF_LABEL = { 60: '1m', 900: '15m', 1800: '30m', 3600: '1H', 14400: '4H' };

export const config = {
  pairs: ['OANDA:AUDUSD', 'OANDA:GBPUSD', 'OANDA:AUDJPY'],
  pip: 0.0001,
  // Per-instrument overrides. pip: the unit risk is shown in. scale: multiplies every pip-based threshold
  // (stop buffer, voids, large stop, decision areas). Also: unit (label), currencies (news),
  // dailyBreak {zone,start,end} (no stale warning) and gapToleranceMinutes — for indices like FX:NAS100.
  instruments: {
    'OANDA:AUDJPY': { pip: 0.01 },
  },
  displayZone: 'Africa/Johannesburg',

  // Alerts form only inside an allowed window and outside every excluded window.
  // Your choice (2026-11-11): 22:00–05:00 SAST is a no-trade zone (still tracked silently). Names are just labels.
  sessions: {
    allowed: [
      { name: 'Asia', zone: 'Africa/Johannesburg', start: '05:00', end: '10:00' },
      { name: 'London', zone: 'Africa/Johannesburg', start: '10:00', end: '15:00' },
      { name: 'New York', zone: 'Africa/Johannesburg', start: '15:00', end: '22:00' },
    ],
    excluded: [],
  },
  // Forex week: Sunday 17:00 to Friday 17:00 New York time.
  marketZone: 'America/New_York',

  tapWindowCandles: 9,
  flatBeforeCloseMinutes: 5, // prop-firm rule: running trades are closed this long before the daily 17:00 NY close
  nearMissPips: 2,           // came this close without tapping, then reached TP → the setup is invalid
  structureBars: 500,
  dojiBodyPct: 0.10,
  stopBufferPips: 1.0,
  largeStopPips: 20,
  voidMinRun: 5,
  voidFastRun: 3,       // ...or a fast push: this many candles covering voidFastPips
  voidFastPips: 10,
  voidLookback: 40,
  conflictLookback: 20,
  staleMinutes: 10,
  quietFailMinutes: 30,  // feed hiccups only reach Telegram once a pair is this far behind (it catches up by itself)
  inboxFailRuns: 3,      // ...and Telegram-reply read errors after this many failed runs in a row
  dataGapToleranceMinutes: 15, // covers the daily 17:00 NY rollover break
  newsMuteMinutes: 30,
  newsAheadMinutes: 120,
  newsRefreshHours: 6,
  newsUrl: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  checkinHourLocal: 5,
  pruneDays: 14,

  // Decision areas (src/da.js). Starting guesses; tune during calibration.
  da: {
    alertPlays: true,      // false = DA plays are only tracked silently in the journal
    valleyRatio: 0.5,      // a valley row has at most this share of the busiest row on each side
    valleyWindowPips: 10,
    zoneHalfPips: 1,
    validateDays: 7,       // 30m history used for Bard's checks
    reactionPips: 10,
    reactionCandles: 4,
    minReactions: 2,
    maxInsideCloses: 2,    // more consecutive 30m closes inside = consolidation
    maxWidthPips: 6,       // widest a zone may grow over fake-outs
    minGapPips: 15,        // closer zones: keep the one with more reactions
    rangeEdgePct: 25,
    playLookback: 8,       // 15m candles in which the DA touch must happen
  },
};

export const currencies = (pair) => {
  const s = pair.split(':').pop();
  return [s.slice(0, 3), s.slice(3, 6)];
};

// pip: display unit; unit: price step for pip-based thresholds; name: label for risk.
export function instrument(pair) {
  const i = config.instruments[pair] ?? {}, pip = i.pip ?? config.pip;
  return {
    pip, unit: pip * (i.scale ?? 1), name: i.unit ?? 'pips',
    currencies: i.currencies ?? (pair ? currencies(pair) : []),
    gapToleranceMinutes: i.gapToleranceMinutes ?? config.dataGapToleranceMinutes,
    dailyBreak: i.dailyBreak ?? null,
  };
}
