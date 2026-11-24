# Trailhead Pump — Pump.fun Replay Sprint Paper Bot

[![make.fun bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Sidik9991/makefun-pump-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Sidik9991/makefun-pump-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A disciplined momentum bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24 h replay of recorded pump.fun bonding-curve activity (protocol `agent-fun/replay/v2`). Node 22, no dependencies.

## Strategy — Trailhead Pump

Adapted from the Trailhead discipline (scale-in, trailing stop, no re-entry after an exit) that won the dev window of the BTC race bounty.

**Entry (all must hold):** curve mature (≥ 400 slots since creation); real SOL reserves 2–60; over a 40-slot window net buy flow ≥ 1 SOL, ≥ 4 buy trades, ≥ 5 distinct buyers, price up 10–150%, price ≥ 95% of the window high, inflow accelerating into the newer half, and no single wallet over 60% of buy SOL.

**Sizing:** first buy 0.1 SOL; add 0.2 SOL while the price sits above the last buy and the position is at or above cost, up to 2 SOL per coin. False starts cost little; runners get size. Max 5 positions, max 5 SOL at cost.

**Exits (whole position, first trigger wins):** stop loss 30% vs cost; trailing stop 15% from peak once the position is up 10%; fade exit when 20-slot net flow < −1.5 SOL; exit on any single recorded sell ≥ 5 SOL; 1500-slot time limit unless up ≥ 5%.

**Drawdown guard:** equity (cash + marked positions) is tracked against its running peak. New entries halt while equity is > 10% below peak; they resume once it recovers to within 5%. Exits keep running while halted.

**Guardrail probes:** the run must end with round trips ≥ 0.01 SOL on at least 20 coins. When fills or coins lag a block-time pace, the bot opens tiny 0.02 SOL probe round trips until back on pace.

Deterministic: no clock, no randomness, no network at replay time.

## Dev-window results (kit's offline sim, `tools/backtest.ts` + `tools/sweep.ts`)

- Pass 1: net **+0.154 SOL**, 277 fills, 45 coins, 93 trips, max drawdown 9.3%.
- Pass 2 (sweep-tuned, 4 fail keys): mean net **+1.059 SOL** (worst key +1.025), 338 fills, 59 coins, 106 trips, 15 wins, max drawdown 8.3%; at 2× fees still **+0.399 SOL**.
- `grade-local` (process driver, the server's own grader on the dev window): net **+0.563 SOL** (return 5.6%, 90% interval −1.47..+3.62 SOL), 341 fills, 60 coins, 106 round trips, win rate 12.3%, max drawdown 9.7%; guardrails met; L1 regrade reproduced byte for byte. Top 3 coins made 94% of the gains — the dev score leans on a few coins, and the final window is a different 24 h, so this is not a forecast.
- Kit pilot momentum baseline on the same window: −9.384 SOL (for reference only).

## Run it

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout
node tools/backtest.ts <kit dir>          # offline backtest on the dev window
node tools/sweep.ts <kit dir> '{}' '{"trail":[0.15,0.25]}'  # parameter sweep
```

## Layout

- `main.ts` — entrypoint, hands the strategy to the SDK shim.
- `strategy.ts` — the bot: tape, entry signal, scale-in, exits, drawdown guard, probes.
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `tools/` — the kit's offline sim, backtest and sweep tools (local validation only).
