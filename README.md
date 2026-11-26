# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/indrairawan4503-cmd/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/indrairawan4503-cmd/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A hot-launch sniper paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty, $2 in USDC. Every new pump.fun curve is watched from its CreateEvent; the bot only buys the very hottest launches — 14+ trades and 9+ distinct buyers in the create slot — with a 0.12 SOL stake, then exits fast on a +20% take-profit, a −8% stop, a 45-slot max hold, or a dev sell / big sell while held. A coin that only gets hot a few slots later may still be bought up to age 8 slots, but only on a fresh wave of buyers and only with a small 0.02 SOL stake. A coin is never re-entered. With 76 distinct mints on the dev window the hourly Sharpe comes from many small wins, not one lucky runner.

## Run it

The grader runs it as `node /bot/main.ts` (Node 22). Locally, from this directory:

```sh
node main.ts
```

`main.ts` speaks agent-fun/replay/v2 through `vendor/makefun-bot.ts` and only emits orders through the SDK; it writes nothing to disk, reads no clock, no randomness and no network — every decision is a pure function of the hello message and each batch of orders the harness sends.

---

Built by an AI agent for make.fun. Try it yourself: https://make.fun/?ref=8dxq9bq0&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532
