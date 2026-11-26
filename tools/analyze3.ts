// Data analysis 3: what predicts the second leg? For every universe coin, compute the
// entry-time features a sniper sees in the create slot, plus (a) the max favorable
// excursion of the price in slots 2..30 after creation (what a take-profit could catch),
// (b) the forward return to +30 and +120 slots. Then bucket the excursion by each feature.

import { gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const KIT = process.argv[2] ?? '/Users/toor/.agentfun/pilot/kit-dev/pilot-pumpfun-replay-kit';
const manifest = JSON.parse(readFileSync(`${KIT}/dataset/manifest.json`, 'utf8'));
const files = readdirSync(`${KIT}/dataset/events`).filter((f) => f.endsWith('.ndjson.gz')).sort();
const events: any[] = [];
for (const f of files) {
  const raw = gunzipSync(readFileSync(`${KIT}/dataset/events/${f}`)).toString('utf8');
  for (const line of raw.split('\n')) if (line.length > 0) events.push(JSON.parse(line));
}
const sample = manifest.universe.sample;
const universe = new Set<string>();
for (const e of events) {
  if (e.event !== 'CreateEvent') continue;
  if (e.quote_mint !== '11111111111111111111111111111111' || e.is_mayhem_mode || e.is_cashback_enabled) continue;
  const h = BigInt(`0x${createHash('sha256').update(e.mint, 'utf8').digest('hex')}`);
  if (h % BigInt(sample.modulus) === BigInt(sample.residue)) universe.add(e.mint);
}

interface CoinPath {
  mint: string;
  createSlot: number;
  creator: string;
  vq0: number;
  vt0: number;
  bySlot: Map<number, number>; // slot -> price after that slot's trades
  rqBySlot: Map<number, number>;
  trades: { slot: number; isBuy: boolean; sol: bigint; user: string; rqBefore: bigint }[];
}
const coins = new Map<string, CoinPath>();
for (const e of events) {
  if (!universe.has(e.mint)) continue;
  if (e.event === 'CreateEvent') {
    coins.set(e.mint, {
      mint: e.mint, createSlot: e.slot, creator: e.creator,
      vq0: Number(e.virtual_quote_reserves), vt0: Number(e.virtual_token_reserves),
      bySlot: new Map(), rqBySlot: new Map(), trades: [],
    });
  } else if (e.event === 'TradeEvent') {
    const c = coins.get(e.mint);
    if (!c) continue;
    c.bySlot.set(e.slot, Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves));
    c.rqBySlot.set(e.slot, Number(e.real_quote_reserves));
    c.trades.push({ slot: e.slot, isBuy: e.is_buy, sol: BigInt(e.sol_amount), user: e.user, rqBefore: BigInt(e.real_quote_reserves) + BigInt(e.sol_amount) });
  }
}
function priceAt(c: CoinPath, slot: number): number | null {
  let best: number | null = null;
  let bestSlot = -1;
  for (const [s, p] of c.bySlot) if (s <= slot && s > bestSlot) { bestSlot = s; best = p; }
  return best;
}
function maxPriceIn(c: CoinPath, from: number, to: number): number | null {
  let m: number | null = null;
  for (const [s, p] of c.bySlot) if (s >= from && s <= to && (m === null || p > m)) m = p;
  return m;
}

interface Row {
  devBuy: number;
  buyers: number;
  trades: number;
  bought: number;
  sold: number;
  bigSellBps: number;
  topShare: number;
  runup: number;
  rq: number;
  maxExc30: number; // max price slots 2..30 / fill price - 1
  maxExc120: number;
  fwd30: number;
  fwd120: number;
}
const rows: Row[] = [];
for (const c of coins.values()) {
  const pFill = priceAt(c, c.createSlot + 2);
  const p30 = priceAt(c, c.createSlot + 30);
  const p120 = priceAt(c, c.createSlot + 120);
  if (pFill === null || p30 === null || p120 === null) continue;
  const m30 = maxPriceIn(c, c.createSlot + 2, c.createSlot + 30);
  const m120 = maxPriceIn(c, c.createSlot + 2, c.createSlot + 120);
  if (m30 === null || m120 === null) continue;
  // entry features from the create slot only (what the bot sees at age 0)
  const ct = c.trades.filter((t) => t.slot === c.createSlot);
  let devBuy = 0n;
  let bought = 0n;
  let sold = 0n;
  const buyers = new Map<string, bigint>();
  let bigSell = 0n;
  for (const t of ct) {
    const isDev = t.user === c.creator;
    if (t.isBuy) {
      bought += t.sol;
      if (isDev) devBuy += t.sol;
      else buyers.set(t.user, (buyers.get(t.user) ?? 0n) + t.sol);
    } else if (isDev) {
      // dev sold
    } else {
      sold += t.sol;
      if (t.rqBefore > 0n) {
        const bps = (t.sol * 10_000n) / t.rqBefore;
        if (bps > bigSell) bigSell = bps;
      }
    }
  }
  let top = 0n;
  for (const v of buyers.values()) if (v > top) top = v;
  const p0 = c.vq0 / c.vt0;
  const rq = c.rqBySlot.get(c.createSlot) ?? 0;
  rows.push({
    devBuy: Number(devBuy) / 1e9,
    buyers: buyers.size,
    trades: ct.length,
    bought: Number(bought) / 1e9,
    sold: Number(sold) / 1e9,
    bigSellBps: Number(bigSell),
    topShare: bought > 0n ? Number((top * 10_000n) / bought) / 100 : 0,
    runup: (priceAt(c, c.createSlot) ?? p0) / p0,
    rq: rq / 1e9,
    maxExc30: m30 / pFill - 1,
    maxExc120: m120 / pFill - 1,
    fwd30: p30 / pFill - 1,
    fwd120: p120 / pFill - 1,
  });
}
console.log(`coins: ${rows.length}`);
console.log(`maxExc30: mean ${(rows.reduce((a, r) => a + r.maxExc30, 0) / rows.length * 100).toFixed(1)}%  frac>10% ${rows.filter((r) => r.maxExc30 > 0.1).length}  frac>20% ${rows.filter((r) => r.maxExc30 > 0.2).length}  frac>50% ${rows.filter((r) => r.maxExc30 > 0.5).length}`);
console.log(`maxExc120: frac>10% ${rows.filter((r) => r.maxExc120 > 0.1).length}  frac>20% ${rows.filter((r) => r.maxExc120 > 0.2).length}  frac>50% ${rows.filter((r) => r.maxExc120 > 0.5).length}`);
console.log(`fwd30 mean ${(rows.reduce((a, r) => a + r.fwd30, 0) / rows.length * 100).toFixed(1)}%  fwd120 mean ${(rows.reduce((a, r) => a + r.fwd120, 0) / rows.length * 100).toFixed(1)}%`);

function bucket(label: string, f: (r: Row) => string) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = f(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  console.log(`\n${label}:`);
  for (const [k, rs] of [...groups.entries()].sort()) {
    const exc = rs.reduce((a, r) => a + r.maxExc30, 0) / rs.length;
    const up20 = rs.filter((r) => r.maxExc30 > 0.2).length;
    const fwd = rs.reduce((a, r) => a + r.fwd30, 0) / rs.length;
    console.log(`  ${k.padEnd(22)} n=${String(rs.length).padStart(4)}  mean maxExc30 ${(exc * 100).toFixed(1)}%  exc>20%: ${up20} (${((up20 / rs.length) * 100).toFixed(0)}%)  mean fwd30 ${(fwd * 100).toFixed(1)}%`);
  }
}
bucket('buyers in create slot', (r) => (r.buyers === 0 ? '0' : r.buyers <= 2 ? '1-2' : r.buyers <= 4 ? '3-4' : r.buyers <= 8 ? '5-8' : '9+'));
bucket('devBuy SOL', (r) => (r.devBuy === 0 ? '0' : r.devBuy < 0.1 ? '<0.1' : r.devBuy < 0.5 ? '0.1-0.5' : r.devBuy < 1.5 ? '0.5-1.5' : '1.5+'));
bucket('runup in create slot', (r) => (r.runup < 1.0 ? '<1.0x' : r.runup < 1.1 ? '1.0-1.1x' : r.runup < 1.3 ? '1.1-1.3x' : r.runup < 1.6 ? '1.3-1.6x' : '1.6x+'));
bucket('bought SOL in create slot', (r) => (r.bought < 0.5 ? '<0.5' : r.bought < 2 ? '0.5-2' : r.bought < 5 ? '2-5' : '5+'));
bucket('top buyer share %', (r) => (r.topShare < 30 ? '<30' : r.topShare < 50 ? '30-50' : r.topShare < 70 ? '50-70' : '70+'));
bucket('bigSell bps', (r) => (r.bigSellBps === 0 ? '0' : r.bigSellBps < 200 ? '1-200' : r.bigSellBps < 800 ? '200-800' : '800+'));
bucket('real SOL reserve', (r) => (r.rq < 1 ? '<1' : r.rq < 3 ? '1-3' : r.rq < 8 ? '3-8' : '8+'));
bucket('trades in create slot', (r) => (r.trades <= 2 ? '<=2' : r.trades <= 5 ? '3-5' : r.trades <= 10 ? '6-10' : '11+'));
