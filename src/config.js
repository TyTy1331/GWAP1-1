// All tunable settings live here. Times are local market time in the given IANA zone.
export const TF = { M1: 60, M15: 900, M30: 1800, H1: 3600, H4: 14400 };
export const TF_LABEL = { 60: '1m', 900: '15m', 1800: '30m', 3600: '1H', 14400: '4H' };

export const config = {
  pairs: ['OANDA:AUDUSD', 'OANDA:GBPUSD'],
  pip: 0.0001,
  displayZone: 'Africa/Johannesburg',

  // Alerts form only inside an allowed window and outside every excluded window.
  // Your choice (2026-11-05): every hour except 00:00–05:00 SAST. Names are just labels in the alerts.
  sessions: {
    allowed: [
      { name: 'Asia', zone: 'Africa/Johannesburg', start: '05:00', end: '10:00' },
      { name: 'London', zone: 'Africa/Johannesburg', start: '10:00', end: '15:00' },
      { name: 'New York', zone: 'Africa/Johannesburg', start: '15:00', end: '24:00' },
    ],
    excluded: [],
  },
  // Forex week: Sunday 17:00 to Friday 17:00 New York time.
  marketZone: 'America/New_York',

  tapWindowCandles: 9,
  structureBars: 500,
  dojiBodyPct: 0.10,
  stopBufferPips: 1.0,
  largeStopPips: 20,
  voidMinRun: 5,
  voidLookback: 40,
  conflictLookback: 20,
  staleMinutes: 10,
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
