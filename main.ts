// Pump.fun Sharpe Sprint — variant C v2: hot-launch sniper, broad diversification.
//
// The strategy lives in strategy.ts (createStrategy). This file is only the entrypoint
// the grader runs as `node /bot/main.ts`: it wires the strategy into the agent-fun/replay/v2
// protocol via the SDK shim in vendor/makefun-bot.ts. Every decision is a pure function of
// the hello message and each batch of orders the harness sends; the bot writes nothing to
// disk and only emits orders through the SDK.
//
// Gate self-check: before any batch of orders leaves this file, it is checked against the
// harness caps from the hello message (at most max_orders_per_batch orders, every amount
// positive, slippage inside 0..10000). A strategy bug fails loudly here, on the first bad
// batch, instead of surfacing as a rejected run in grading.

import { runBot, type OrderInput } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => {
    const orders = strategy.onBatch(state, batch);
    const cap = state.hello.caps.max_orders_per_batch;
    if (orders.length > cap) {
      throw new Error(`gate self-check: ${orders.length} orders in one batch, cap is ${cap}`);
    }
    for (const o of orders) {
      const amount = o.side === 'buy' ? BigInt(o.quote_lamports) : BigInt(o.token_amount);
      if (amount <= 0n) throw new Error(`gate self-check: non-positive ${o.side} amount on ${o.mint}`);
      if (o.max_slippage_bps < 0 || o.max_slippage_bps > 10_000) {
        throw new Error(`gate self-check: slippage ${o.max_slippage_bps} out of range on ${o.mint}`);
      }
    }
    return orders as OrderInput[];
  },
});
