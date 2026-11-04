# No-wick alert bot

Telegram alerts for BardFX's no-wick 1:1 entry model on OANDA AUDUSD and GBPUSD, run every 5 minutes by GitHub Actions for $0. Alerts only — it never places trades.

- Detects bullish (open = low) and bearish (open = high) no-wick candles on the 15m, upgrading to 30m/1H when they line up
- Checks the 15m body-close structure (BOS) and 4H alignment, sessions and red-folder news
- Sends formation, tap (within 9 candles), TP/SL result, daily check-in and weekly recap messages

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
