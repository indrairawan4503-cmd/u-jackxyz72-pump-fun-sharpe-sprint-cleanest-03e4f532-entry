// Pump.fun Sharpe Sprint — variant C v2 strategy: hot-launch sniper, broad diversification.
//
// What the dev-window data actually says (see tools/analyze*.ts): the price jumps a median
// +19% in the first two slots after creation, then mostly flatlines — most coins never trade
// again, so buying an average launch just pays fees. The only coins with a real second leg
// are the VERY hot ones: 14+ trades and 9+ distinct buyers in the create slot. This bot
// buys only those, one 0.12 SOL stake per coin, and exits fast (take-profit +20%, stop
// -8%, max hold 45 slots, immediate exit on a dev sell or a single large sell while held).
// A coin that only gets hot a few slots later may still be bought up to age 8 slots, but
// only on a fresh wave (2+ distinct buyers in the last 8 slots) and only with a small
// 0.02 SOL stake — the second wave is weaker evidence. A coin is never re-entered after
// an exit or a failed filter, so there are no revenge trades. With 76 distinct mints the
// variance averages out and the hourly Sharpe comes from many small wins, not one runner.
//
// Deterministic by construction: every decision is a pure function of the hello message
// and each batch of orders the harness sends (events, marks, fills, account) plus the
// slot it carries. No clock, no randomness, no network, no environment reads, no
// eval/Function/dynamic import. The strategy writes nothing to disk; it only returns
// orders through the SDK shim.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const BPS = 10_000n;

export interface Params {
  minAge: number;
  maxAge: number;
  stakeLamports: number;
  minBuyLamports: number;
  minRealSol: number;
  maxRealSol: number;
  maxDevBuy: number;
  minTrades: number;
  minBuyers: number;
  maxBuyers: number;
  /** Lamports bought by anyone in the create slot, at least this (hot launch). */
  minBoughtLamports: number;
  maxTopBuyerShareBps: number;
  maxSellRatioBps: number;
  maxBigSellBps: number;
  minRunupBps: number;
  maxRunupBps: number;
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  buySlippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is worth tp1Bps over its cost (1_000_000 = off). */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the first take-profit, the rest stops out at this much under its cost (bps; negative = above cost). */
  slAfterTp1Bps: number;
  tpBps: number;
  slBps: number;
  trailArmBps: number;
  trailBps: number;
  maxHold: number;
  exitOnDevSell: boolean;
  exitBigSellBps: number;
  /** Exit when the recent net flow falls below minus this many lamports (huge = off). */
  exitFlowLamports: number;
  staleSlots: number;
  /** Creator's own buys in the create slot: at least this (skin in the game). */
  minDevBuy: number;
  /** Late entries (age >= lateAge) need a fresh wave: net flow over the last lateFlowWindow slots. */
  lateAge: number;
  lateFlowWindow: number;
  lateMinFlowLamports: number;
  lateMinBuyers: number;
  /** Stake for late entries (age >= lateAge): smaller, the second wave is weaker evidence. */
  lateStakeLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 8,
  stakeLamports: 120_000_000,
  minBuyLamports: 20_000_000,
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  maxDevBuy: 2_500_000_000,
  minTrades: 14,
  minBuyers: 9,
  maxBuyers: 20,
  minBoughtLamports: 0,
  maxTopBuyerShareBps: 10000,
  maxSellRatioBps: 10000,
  maxBigSellBps: 10000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindow: 12,
  minFlowLamports: -1_000_000_000_000,
  minRecentBuyers: 0,
  buySlippageBps: 10_000,
  tp1Bps: 1_000_000,
  tp1PartBps: 5000,
  slAfterTp1Bps: 0,
  tpBps: 2000,
  slBps: 800,
  trailArmBps: 1_000_000,
  trailBps: 800,
  maxHold: 45,
  exitOnDevSell: true,
  exitBigSellBps: 500,
  exitFlowLamports: 1_000_000_000_000,
  staleSlots: 60,
  minDevBuy: 0,
  lateAge: 5,
  lateFlowWindow: 8,
  lateMinFlowLamports: 0,
  lateMinBuyers: 2,
  lateStakeLamports: 20_000_000,
};

const CURVE_FEE_BPS = 125n; // protocol 95 bps + creator 30 bps fallback on trades

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint; // create-time virtual quote reserves (price reference)
  vt0: bigint; // create-time virtual token reserves
  devBuy: bigint; // creator's own buys in the create slot
  trades: number;
  buyers: Map<Pubkey, bigint>; // non-creator buyer -> lamports bought
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint; // largest single non-creator sell, bps of reserve before it
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[]; // trades of the last flowWindow slots
  boughtOnce: boolean; // a buy was already sent on this coin (never re-enter)
  done: boolean; // exited, filtered out for good, or completed
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint; // tx fees paid on fills for this position
  best: bigint; // best net value seen (for the trailing stop)
  bigSellAtOpen: bigint; // bigSellBps at the moment the position opened
  devSoldAtOpen: boolean;
  tookTp1: boolean; // the first partial take-profit already fired
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  /** Coins still inside their entry-age window, in creation order (the entry loop only ever looks at these). */
  const young: Coin[] = [];
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell currently in flight (its fill has not come back yet). */
  const selling = new Set<Pubkey>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const coin: Coin = {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Map(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          boughtOnce: false,
          done: false,
          complete: false,
        };
        coins.set(e.mint, coin);
        young.push(coin);
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const isDev = e.user === c.creator;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) {
            c.devBuy += sol;
          } else if (!isDev) {
            c.buyers.set(e.user, (c.buyers.get(e.user) ?? 0n) + sol);
          }
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const reserveBefore = BigInt(e.real_quote_reserves) + sol;
          if (reserveBefore > 0n) {
            const bps = (sol * BPS) / reserveBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        // CompleteEvent: the curve migrated, the tradable life is over.
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold, and distinct buyers, over the last flowWindow slots. */
  function recentFlow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  /** Largest single non-creator buyer's share of all buys, in bps. */
  function topBuyerShareBps(c: Coin): bigint {
    if (c.bought <= 0n) return 0n;
    let top = 0n;
    for (const v of c.buyers.values()) if (v > top) top = v;
    return (top * BPS) / c.bought;
  }

  /** Net flow and distinct buyers over the last `window` slots, without pruning the tape. */
  function windowFlow(c: Coin, slot: number, window: number): { net: bigint; buyers: number } {
    const from = slot - window;
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.slot <= from) continue;
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy') return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell') return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Reconcile held positions with the fills that resolved since the last batch.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // Harness close (complete / flatten / writeoff): the position is gone.
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const c = coins.get(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            bigSellAtOpen: c?.bigSellBps ?? 0n,
            devSoldAtOpen: c?.devSold ?? false,
            tookTp1: false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // ---- Exits first: every held position is re-priced on this batch's marks. ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, bigSellAtOpen: c?.bigSellBps ?? 0n, devSoldAtOpen: c?.devSold ?? false, tookTp1: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          // First partial take-profit: bank half on the early pop, let the rest ride.
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
            const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true; // take profit
          const sl = h.tookTp1 ? BigInt(P.slAfterTp1Bps) : BigInt(P.slBps);
          if (value * BPS <= basis * (BPS - sl)) exit = true; // stop loss (breakeven after TP1)
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true; // trailing stop
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true; // max hold
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true; // creator dumped while held
          if (c.bigSellBps > h.bigSellAtOpen && c.bigSellBps > BigInt(P.exitBigSellBps)) exit = true; // one big sell while held
          if (recentFlow(c, state.slot).net < -BigInt(P.exitFlowLamports)) exit = true; // buy-side flow reversed
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true; // gone stale
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true; // never re-enter after an exit
      }

      // ---- Entries: one small equal stake per clean launch, never re-entering. ----
      // Only coins still inside their entry-age window are considered; a coin whose
      // window passed is marked done and dropped from the young list here.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      let yi = 0;
      while (yi < young.length) {
        const c = young[yi]!;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true; // window passed without a buy: never revisit
          young.splice(yi, 1);
          continue;
        }
        yi++;
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.boughtOnce) continue;
        if (age < P.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          c.done = true; // creator already dumped: skip for good
          continue;
        }
        // Rug / concentration filter on the opening tape.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        // Late entries need a FRESH wave of buying right now, not just the opening spike.
        if (age >= P.lateAge) {
          const lf = windowFlow(c, state.slot, P.lateFlowWindow);
          if (lf.net < BigInt(P.lateMinFlowLamports) || lf.buyers < P.lateMinBuyers) continue;
        }
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought < BigInt(P.minBoughtLamports)) continue;
        if (topBuyerShareBps(c) > BigInt(P.maxTopBuyerShareBps)) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vq <= 0n || vt <= 0n || c.vq0 <= 0n || c.vt0 <= 0n) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup < BigInt(P.minRunupBps) || runup > BigInt(P.maxRunupBps)) continue;
        const fl = recentFlow(c, state.slot);
        if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) continue;
        // Size: the equal stake, capped at 1% of real reserve by the harness.
        // Late entries (a second wave, weaker evidence) take the smaller late stake.
        const targetStake = age >= P.lateAge ? BigInt(P.lateStakeLamports) : BigInt(P.stakeLamports);
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = targetStake < maxBuy ? targetStake : maxBuy;
        if (amount < BigInt(P.minBuyLamports)) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.boughtOnce = true;
        open += 1;
      }
      return orders;
    },
  };
}
