# No-wick alert bot

Telegram alerts for BardFX's no-wick 1:1 entry model on OANDA AUDUSD, GBPUSD and AUDJPY (15m), FOREX.com GER40 (5m) and BTCUSD (30m, 7 days a week), run every 5 minutes by GitHub Actions for $0. Alerts only — it never places trades.

- Detects bullish (open = low) and bearish (open = high) no-wick candles on each symbol's timeframe, upgrading to higher timeframes when they line up
- Checks body-close structure (BOS) against a higher timeframe (forex 15m vs 4H, GER40 5m vs 1H, BTCUSD 30m vs 4H), sessions and red-folder news
- Sends formation, tap (within 9 candles), TP/SL result, daily check-in and weekly recap messages
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
