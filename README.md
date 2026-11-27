# No-wick alert bot

Telegram alerts for BardFX's no-wick 1:1 entry model on OANDA AUDUSD, GBPUSD, AUDJPY, AUDCAD and USDCAD (15m), FOREX.com GER40 (5m) and BTCUSD (1H, 7 days a week), checked every minute in trading hours and hourly otherwise by GitHub Actions for $0. Alerts only — it never places trades.

- Detects bullish (open = low) and bearish (open = high) no-wick candles on each symbol's timeframe, upgrading to higher timeframes when they line up
- Checks body-close structure (BOS) against a higher timeframe (forex 15m vs 4H, GER40 5m vs 1H, BTCUSD 1H vs 4H and 1D, every no-wick sent with a valid / not valid verdict), sessions and red-folder news
- Sends formation, tap (within 9 candles), TP/SL result, morning briefing (05:00 SAST) and weekly recap messages
- One-tap report buttons under alerts, plus `/stats` and `/why` commands
- Keeps a permanent monthly trade journal (CSV) of every no-wick, alerted or skipped, on the `bot-state` branch

Setup: [docs/setup.md](docs/setup.md). Requirements and design: `docs/brainstorms/` and `docs/plans/`.

```bash
npm ci --ignore-scripts
```

```bash
npm test
```

```bash
DRY_RUN=1 STATE_PATH=state/state.json node src/run.js
```

Price data comes from TradingView through the unofficial community library [TradingView-API](https://github.com/Mathieu2301/TradingView-API). It can break if TradingView changes its site; the bot reports stale data and failed runs on Telegram when that happens.
