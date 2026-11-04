# Setup guide

Everything here is free. Budget about 20 minutes.

## Before you start: this repo is public

Free unlimited GitHub Actions minutes need a **public** repository. That means anyone can read:

- the `bot-state` branch: your active levels, open trades with entries/stops/TP, and your results and win rate
- the Actions run logs (they only print counts and IDs, never your tokens or messages)

Your Telegram token, chat ID and any TradingView login stay private as encrypted secrets. If you don't want your signals visible, the alternative is running the bot on a spare phone at home instead.

## 1. Create the Telegram bot (2 minutes)

1. In Telegram, open a chat with **@BotFather** and send `/newbot`. Pick any name and username.
2. BotFather replies with a **token** like `123456789:AA...`. Keep it secret.
3. Open a chat with your new bot and send it any message (e.g. "hi").
4. In a browser, open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` (paste your token in place of `<YOUR_TOKEN>`).
   Find `"chat":{"id":` in the reply. That number is your **chat ID**.

## 2. Create the GitHub repository

1. Sign in at github.com and create a new **public** repository (e.g. `nowick-alert-bot`). Don't add a README.
2. Push this folder to it. From this folder in a terminal:

```bash
git init -b main
```

```bash
git add .
```

```bash
git commit -m "No-wick alert bot"
```

```bash
git remote add origin https://github.com/<you>/nowick-alert-bot.git
```

```bash
git push -u origin main
```

## 3. Add the secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from BotFather |
| `TELEGRAM_CHAT_ID` | your chat ID |

Leave `TV_SESSION` / `TV_SIGNATURE` out for now (see step 6).

## 4. First run

1. Go to the **Actions** tab. If GitHub asks, click to enable workflows.
2. Pick **scan** → **Run workflow**.
3. Within a minute you should get "🤖 No-wick bot running…" on Telegram. A `bot-state` branch appears in the repo.

The first run only records "now" as its starting point. It never sends alerts for older candles. From then on it runs every 5 minutes by itself.

If the run fails with a TradingView error, GitHub's servers may be blocked from TradingView's free data. Try step 6.

## 5. Reading what you get

| Message | Meaning |
|---|---|
| 🟡 BUY/SELL | A valid no-wick formed. Entry, stops, TP, trend, session, tap deadline and any warnings |
| 🔼 upgraded | The 30m or 1H candle is also a no-wick. Stops and window recalculated on that timeframe |
| 🎯 tapped | Price touched the level inside its 9-candle window ("2/9" = 2nd candle) |
| ✅ / ❌ | TP or stop was hit first |
| ⚠️ | Something needs your eye: stale data, news calendar down, a data gap, a failed run |
| 🤖 | Daily check-in at 05:00 SAST on market days. **If it stops arriving, the bot has stopped** |
| 📊 | Weekly recap after Friday's close |

Some runs in the Actions tab show as "cancelled". That's normal: GitHub drops a waiting run when a newer one is queued, and the next run catches up.

Taps and results are checked on 1-minute candles each run. Because GitHub's scheduler often starts runs a few minutes late, alerts can arrive 5–15 minutes after the event. The message always says when it actually happened.

## Reporting your own trades (#05TP / #05SL)

Every setup gets a short number, shown in its alerts (e.g. **#05 AUDUSD 15m SELL**). When your trade closes, send the bot `#05TP` or `#05SL` (`#5 tp` works too, and so do several in one message). The next run, within 5–15 minutes, replies "📝 #05 … marked TP ✅". Sending a different result for the same number corrects it.

The weekly recap then shows **Your trades** (what you reported) separately from **Bot tracking** (whether the exact 1:1 levels were hit). Your results can differ from the bot's when you pre-enter, move to break-even, or pull TP in. Only the chat the alerts go to can report trades.

## The trade journal (your data for analysis)

Every 15m no-wick the bot sees is written to a monthly spreadsheet on the `bot-state` branch: `journal/2026-11.csv`, `journal/2026-12.csv`, and so on. That includes the ones it **skipped**, with the reason. Skipped ones are tracked silently (no alerts), so you can later see how they would have done. Journal files are never deleted.

Each row has: number, whether it was alerted or skipped (and why), pair, timeframe, BUY/SELL, formation time (UTC and SAST), level, stop, alternative stop, TP, risk, 15m and 4H trend with BOS counts, session, warnings, upgrades, tap time and n/9, the bot's result (TP, SL, expired, unknown, no setup, plus whether news muted it), and your reported TP/SL.

A row appears once the setup finishes (TP, SL or expired) or when you report it.

**To download:** open the repo on GitHub → branch selector (says `main`) → `bot-state` → `journal` folder → a month's file → the download button (⬇) at the top right. Opens in Excel or Google Sheets. To have it analyzed, give the files to Claude.

The `bot-state` branch only ever holds the latest copy (one commit, replaced each run), so it doesn't grow with every run. The journal files inside it keep the full history.

## Sending alerts to a Telegram group

1. **Let the bot read group messages.** In @BotFather send `/setprivacy`, pick your bot and choose **Disable**. Without this, Telegram hides normal group messages like `#05TP` from bots.
2. **Add the bot to the group.** In the group: tap the group name → **Add members** → search `GWAPSIGNALS_BOT` → add. If it was already in the group before step 1, remove it and add it again so the privacy change applies.
3. **Get the group's chat ID.** Within a few runs, the bot messages your current chat: "📍 I was added to "…". Its chat ID is -100…". The number starts with a minus sign.
4. **Point the bot at the group.** Repo → Settings → Secrets and variables → Actions → `TELEGRAM_CHAT_ID` → pencil → paste the group's ID, including the minus sign → **Update secret**.

From then on, alerts go to the group, and anyone in the group can report `#05TP`. To switch back, put your personal chat ID back in the secret.

## 6. Optional: TradingView login (only if anonymous data stops working)

Create a **separate free TradingView account just for the bot**. Don't use your main one. Sign in to it in a browser. In the developer tools under Application → Cookies → tradingview.com, copy the `sessionid` and `sessionid_sign` values into secrets `TV_SESSION` and `TV_SIGNATURE`. If you ever see unfamiliar activity on that account, or the bot's dependencies change unexpectedly, log it out everywhere and replace both secrets.

## 7. Calibration (first 1–2 weeks)

On your PC, in this folder:

```bash
npm ci --ignore-scripts
```

```bash
node scripts/calibrate.js AUDUSD 2
```

This prints, in SAST, every 15m no-wick from the last 2 days, whether the bot would have alerted and why not, plus every BOS it saw on the 15m and 4H. Compare against your chart with X Ghost Wickless Candles. Note any disagreements. Thresholds such as the doji size, stop buffer and void length live in `src/config.js`.

## Changing settings

Everything tunable is in `src/config.js`: pairs, session windows, tap window, stop buffer, large-stop threshold, news mute window and check-in time. Commit and push a change, and the next run uses it.

## Updating the TradingView library

The library version is pinned on purpose. To update it, change the version in `package.json`, run `npm install --ignore-scripts`, run `node scripts/calibrate.js` to confirm candles still look right, then commit both `package.json` and `package-lock.json`.
