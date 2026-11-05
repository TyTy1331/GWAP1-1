---
title: "feat: Decision areas (warnings, DA-play alerts, journal)"
type: feat
status: active
date: 2026-11-05
origin: docs/brainstorms/2026-11-04-nowick-alert-bot-requirements.md
---

# feat: Decision areas

## Summary

Detect BardFX's "decision areas" (DAs) automatically on AUDUSD and GBPUSD. Use them three ways:
- warnings on normal alerts
- experimental "🧪 DA PLAY" alerts for counter-trend no-wicks that reject off a DA
- new journal columns, so months of data can show whether DAs help

Restore point before this work: git tag `restore-2026-11-05-before-da` (commit 0f19723).

---

## What Bard says (sources)

- "How to know exactly where price will Reject" (youtube.com/watch?v=Q591vGeiets):
  - DAs are areas where price made **big reactions** over about a week on the 30m.
  - **No consolidation inside**.
  - **No fake-outs**: a body close through, then straight back. When there is one, widen the zone to cover it.
  - Zones too close together get merged into one.
  - Tool: TradingView **fixed range volume profile** from the **previous day's Asia start** to now; DAs sit at the **lowest-volume rows**.
  - Uses:
    - Avoid trading inside a DA.
    - In ranges, prefer buys in the bottom half and sells in the top half.
    - Counter-trend trades are allowed off a DA rejection ("overrules the trend rule").
    - Stop beyond a DA protects it.
    - Higher RR is OK off a DA.
- "How I made $6.5k… new entry model" (G2C_PHK49W0): after tapping a valid DA, plus imbalance above, **one BOS is enough** against the 4H.
- "How I made $7.1k…" (yvbQOxIkyZM): DA plays are counter-trend. He moves his DA after a fake-out. Stop below the DA "with breathing room".

---

## Key decisions

- **Warnings, not filters.** DA detection approximates a visual skill, so normal setups are never blocked by it.
- **DA plays are alerted, clearly labeled "🧪 DA PLAY (experimental)"** (the user chose option 2). They have their own trade numbers, are tracked like normal trades, and are reported **separately** in the recap and journal (`play_type = da`), so they never mix into the main stats.
- **Defaults are starting guesses**, all in `src/config.js` under `da`. Tune them during calibration.

---

## Detection (per pair, refreshed at each 15m close)

1. **Volume profile:**
   - Take the 15m candles from the previous trading day's open (17:00 New York) to now.
   - Spread each candle's volume evenly over its high–low range in 1-pip rows, then smooth over 3 rows.
2. **Candidates:**
   - Rows that are local minima, with volume ≤ `valleyRatio` (0.5) of the highest row within `valleyWindowPips` (10) on **each** side.
   - Zone = row ± 1 pip.
3. **Validation (on the past 7 days of 30m candles):**
   - **Reactions:** price enters the zone and, within 4 candles, moves ≥ `reactionPips` (10) away in either direction. Need ≥ `minReactions` (2).
   - **No consolidation:** more than 2 consecutive 30m closes inside the zone → drop.
   - **Fake-outs:** a 30m body closes beyond the zone, then the next one closes back on the original side → widen that edge to cover the fake close, up to `maxWidthPips` (6). Still faked out at max width → drop.
   - **Spacing:** zones within `minGapPips` (15) of each other → keep the one with more reactions.

---

## Uses

**Warnings on normal alerts:**
- "Entry is inside a decision area (a–b)"
- "Selling near the bottom of the range (n%)" or "Buying near the top (n%)": position between the nearest DA below and above, warning at ≤ 25% for sells and ≥ 75% for buys
- "TP is beyond a DA at x — consider TP just before it"
- ℹ️ "A DA between entry and stop protects it"

**DA play (experimental alert):**
- Applies to a no-wick that would be skipped only because of the trend rule.
- Price touched a DA within the last 8 15m candles and closed back out of it in the trade direction (a rejection).
- At least 1 BOS in the trade direction on the 15m.
- In session, with no news mute.
- Stop = beyond the far edge of the DA + buffer. TP 1:1.
- Gets a trade number and the normal tap, result and break-even alerts.

**Journal:** new columns
- `play_type` (normal / da)
- `da_below`, `da_above`
- `range_pos` (%)
- `in_da`
- `tp_beyond_da`

**Calibration:** `scripts/calibrate.js` prints the current DAs, to compare against hand-drawn ones.

---

## Tests (synthetic candles)

- **Profile valley:** two high-volume clusters with a thin row between them → one candidate at the thin row.
- **Reactions:** a zone touched 3 times, with 12-pip moves away → kept. Touched once → dropped.
- **Consolidation:** 4 closes inside the zone → dropped.
- **Fake-out:** a fake close 2 pips beyond the zone → widened to cover it. A fake-out beyond 6 pips → dropped.
- **Spacing:** two zones 8 pips apart → one kept.
- **Warnings:**
  - entry inside a zone
  - a sell at 15% of the range → warning
  - TP past a DA → warning
- **DA play:**
  - a counter-trend bullish no-wick after a rejection off a DA, with 1 BOS → 🧪 alert with a stop beyond the DA
  - the same without a DA touch → stays skipped
- **Recap and journal:** DA plays are listed separately, and `play_type = da`.

---

## Risks

- FX tick volume and 15m granularity differ from TradingView's profile → levels may sit a pip or two off.
- Tuning is needed. If DA plays perform badly, revert to the restore tag or switch them back to journal-only (one config flag: `da.alertPlays`).
