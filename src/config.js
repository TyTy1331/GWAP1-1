// All tunable settings live here. Times are local market time in the given IANA zone.
export const TF = { M1: 60, M15: 900, M30: 1800, H1: 3600, H4: 14400 };
export const TF_LABEL = { 60: '1m', 900: '15m', 1800: '30m', 3600: '1H', 14400: '4H' };

export const config = {
  pairs: ['OANDA:AUDUSD', 'OANDA:GBPUSD'],
  pip: 0.0001,
  displayZone: 'Africa/Johannesburg',

  // Alerts form only inside an allowed window and outside every excluded window.
  sessions: {
    allowed: [
      { name: 'Late Asia', zone: 'Asia/Tokyo', start: '12:00', end: '17:00' },
      { name: 'London', zone: 'Europe/London', start: '08:00', end: '17:00' },
      { name: 'New York', zone: 'America/New_York', start: '08:00', end: '17:00' },
    ],
    excluded: [
      { name: 'NY open', zone: 'America/New_York', start: '08:00', end: '10:00' },
      { name: 'Late NY', zone: 'America/New_York', start: '15:00', end: '17:00' },
    ],
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
};

export const currencies = (pair) => {
  const s = pair.split(':').pop();
  return [s.slice(0, 3), s.slice(3, 6)];
};
