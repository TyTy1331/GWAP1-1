// All tunable settings live here. Times are local market time in the given IANA zone.
export const TF = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
export const TF_LABEL = { 60: '1m', 300: '5m', 900: '15m', 1800: '30m', 3600: '1H', 14400: '4H', 86400: '1D' };
// Key of each timeframe's candle list in the data passed to processPair.
export const TF_KEY = { 60: 'm1', 300: 'm5', 900: 'm15', 1800: 'm30', 3600: 'h1', 14400: 'h4', 86400: 'd1' };

export const config = {
  // AUDCAD and USDCAD added 2026-11-26: both are pairs Bard trades in his recaps.
  pairs: ['OANDA:AUDUSD', 'OANDA:GBPUSD', 'OANDA:AUDJPY', 'OANDA:AUDCAD', 'OANDA:USDCAD', 'FOREXCOM:GER40', 'CRYPTO:BTCUSD'],
  pip: 0.0001,
  // Per-instrument overrides. pip: the unit risk is shown in. scale: multiplies every pip-based threshold
  // (stop buffer, voids, large stop, decision areas). Also: unit (label), currencies (news),
  // dailyBreak {zone,start,end} (no stale warning) and gapToleranceMinutes — for indices like FX:NAS100.
  // Timeframes: tf (no-wicks and internal trend), ups (upgrades), ext (external trend). Default 15m / 30m,1H / 4H.
  // always: trades 24/7 (no forex weekend). da: false turns decision areas off (they are tuned for forex on the 15m).
  // choch: also alert no-wicks after the first internal BOS against the external trend (change of character).
  // pullback: also alert with the external trend while the internal has 1 BOS against. Not Bard's rule
  // (his videos, Nov 2026): kept for GER40 only, your choice. Elsewhere those setups are tracked silently.
  // ext2: a second external trend that must agree too. verdict: alert every no-wick with a valid / not valid
  // verdict (all trends agree, inside your hours, no news, a stop exists) instead of skipping invalid ones.
  // scale comes from typical candle size: forex 15m ~5 pips, GER40 5m ~23 pts, BTCUSD 1H ~$437 (Nov 2026).
  instruments: {
    'OANDA:AUDJPY': { pip: 0.01 },
    'FOREXCOM:GER40': {
      pip: 1, scale: 4, unit: 'pts', currencies: ['EUR', 'USD'], da: false, choch: true, pullback: true,
      tf: TF.M5, ups: [TF.M15, TF.M30], ext: TF.H1,
      // FOREX.com closes daily 23:05–00:00 Berlin and from Fri 22:05 to Mon 00:00 Berlin.
      dailyBreak: { zone: 'Europe/Berlin', start: '22:00', end: '24:00' },
      gapToleranceMinutes: 70,
    },
    // Your choice (2026-11-27): 1H no-wicks only, every one sent with a verdict; valid when 1H, 4H and 1D agree.
    'CRYPTO:BTCUSD': {
      pip: 1, scale: 85, unit: 'USD', currencies: ['USD'], da: false, always: true, verdict: true,
      tf: TF.H1, ups: [], ext: TF.H4, ext2: TF.D1,
    },
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
  // Prop-firm rule: nothing runs into the next trading day. Running trades end this long before dayEnd,
  // the market's daily close: 00:00 SAST in the New York winter, 23:00 SAST in its summer.
  flatBeforeCloseMinutes: 5,
  dayEnd: { zone: 'America/New_York', time: '17:00' },
  nearMissPips: 2,           // came this close without tapping, then reached TP → the setup is invalid
  structureBars: 500,
  // Doji (ignored as structure): 'pct' = body under dojiBodyPct of the range; 'wicks' = both wicks bigger
  // than the body (Bard's definition). Compare them with scripts/doji-test.js before switching.
  dojiRule: 'pct',
  dojiBodyPct: 0.10,
  stopBufferPips: 2.5,       // Bard: "two to three pip breathing room" (was 1.0 until 2026-11-26)
  // Bard skips the New York open unless the setup is A+. Non-A+ alerts formed in this window get a flag.
  // shortcut: assumes he means the 09:30 New York stock open; move the window if he means 08:00.
  nyOpen: { zone: 'America/New_York', start: '09:15', end: '10:00' },
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
  newsMuteMinutes: 60,   // Bard's full breakdown (Sep 2026): skip one hour before and after red-folder news
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
    tf: i.tf ?? TF.M15, ups: i.ups ?? [TF.M30, TF.H1], ext: i.ext ?? TF.H4,
    always: Boolean(i.always), da: i.da ?? true, choch: Boolean(i.choch), pullback: Boolean(i.pullback),
    ext2: i.ext2 ?? null, verdict: Boolean(i.verdict),
  };
}
