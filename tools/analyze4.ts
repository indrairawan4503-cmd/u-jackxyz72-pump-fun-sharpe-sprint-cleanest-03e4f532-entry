// Data analysis 4: simulate a fixed scalp policy on EVERY universe coin and see which
// entry features predict a profitable scalp. Policy: buy at the fill price (last trade
// price at create+2), then sell at the first slot (<= create+32) where price >= fill*TP
// or <= fill*(1-SL), else sell at create+32. PnL is net of a 2.75% round-trip fee haircut.
// Bucket the resulting per-coin PnL by entry features to find the selection signal.

import { gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const KIT = process.argv[2] ?? '/Users/toor/.agentfun/pilot/kit-dev/pilot-pumpfun-replay-kit';
const TP = Number(process.argv[3] ?? '1.15');
const SL = Number(process.argv[4] ?? '0.92');
const HOLD = Number(process.argv[5] ?? '32');
const FEE = 0.0275;
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
  bySlot: Map<number, number>;
  rqBySlot: Map<number, number>;
  trades: { slot: number; isBuy: boolean; sol: bigint; user: string }[];
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
    c.trades.push({ slot: e.slot, isBuy: e.is_buy, sol: BigInt(e.sol_amount), user: e.user });
  }
}
function priceAt(c: CoinPath, slot: number): number | null {
  let best: number | null = null;
  let bestSlot = -1;
  for (const [s, p] of c.bySlot) if (s <= slot && s > bestSlot) { bestSlot = s; best = p; }
  return best;
}

interface Row {
  devBuy: number; buyers: number; trades: number; bought: number; sold: number;
  topShare: number; runup: number; rq: number; pnl: number; exit: string;
}
const rows: Row[] = [];
for (const c of coins.values()) {
  const pFill = priceAt(c, c.createSlot + 2);
  if (pFill === null) continue;
  // scalp simulation over slot prices
  let pnl: number | null = null;
  let exit = 'hold';
  for (let s = c.createSlot + 3; s <= c.createSlot + HOLD; s++) {
    const p = priceAt(c, s);
    if (p === null) continue;
    if (p >= pFill * TP) { pnl = TP - 1 - FEE; exit = 'tp'; break; }
    if (p <= pFill * SL) { pnl = SL - 1 - FEE; exit = 'sl'; break; }
  }
  if (pnl === null) {
    const pEnd = priceAt(c, c.createSlot + HOLD);
    pnl = (pEnd === null ? 0 : pEnd / pFill - 1) - FEE;
    exit = 'hold';
  }
  const ct = c.trades.filter((t) => t.slot === c.createSlot);
  let devBuy = 0n; let bought = 0n; let sold = 0n;
  const buyers = new Map<string, bigint>();
  for (const t of ct) {
    const isDev = t.user === c.creator;
    if (t.isBuy) {
      bought += t.sol;
      if (isDev) devBuy += t.sol;
      else buyers.set(t.user, (buyers.get(t.user) ?? 0n) + t.sol);
    } else if (!isDev) sold += t.sol;
  }
  let top = 0n;
  for (const v of buyers.values()) if (v > top) top = v;
  const p0 = c.vq0 / c.vt0;
  rows.push({
    devBuy: Number(devBuy) / 1e9, buyers: buyers.size, trades: ct.length,
    bought: Number(bought) / 1e9, sold: Number(sold) / 1e9,
    topShare: bought > 0n ? Number((top * 10_000n) / bought) / 100 : 0,
    runup: (priceAt(c, c.createSlot) ?? p0) / p0,
    rq: (c.rqBySlot.get(c.createSlot) ?? 0) / 1e9,
    pnl, exit,
  });
}
console.log(`policy TP ${TP} SL ${SL} hold ${HOLD}: coins ${rows.length}`);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`mean pnl/coin ${(mean(rows.map((r) => r.pnl)) * 100).toFixed(2)}%  exits tp ${rows.filter((r) => r.exit === 'tp').length} sl ${rows.filter((r) => r.exit === 'sl').length} hold ${rows.filter((r) => r.exit === 'hold').length}`);
console.log(`total if 0.08 stake on all: ${(rows.reduce((a, r) => a + r.pnl, 0) * 0.08).toFixed(3)} SOL`);
function bucket(label: string, f: (r: Row) => string) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) { const k = f(r); groups.set(k, [...(groups.get(k) ?? []), r]); }
  console.log(`\n${label}:`);
  for (const [k, rs] of [...groups.entries()].sort()) {
    console.log(`  ${k.padEnd(20)} n=${String(rs.length).padStart(4)}  mean pnl ${(mean(rs.map((r) => r.pnl)) * 100).toFixed(2)}%  tp ${rs.filter((r) => r.exit === 'tp').length} sl ${rs.filter((r) => r.exit === 'sl').length}`);
  }
}
bucket('runup', (r) => (r.runup < 1.1 ? '1.0-1.1x' : r.runup < 1.3 ? '1.1-1.3x' : r.runup < 1.6 ? '1.3-1.6x' : '1.6x+'));
bucket('buyers', (r) => (r.buyers === 0 ? '0' : r.buyers <= 2 ? '1-2' : r.buyers <= 4 ? '3-4' : r.buyers <= 8 ? '5-8' : '9+'));
bucket('bought SOL', (r) => (r.bought < 0.5 ? '<0.5' : r.bought < 2 ? '0.5-2' : r.bought < 5 ? '2-5' : '5+'));
bucket('rq SOL', (r) => (r.rq < 1 ? '<1' : r.rq < 3 ? '1-3' : r.rq < 8 ? '3-8' : '8+'));
bucket('devBuy SOL', (r) => (r.devBuy === 0 ? '0' : r.devBuy < 0.5 ? '<0.5' : r.devBuy < 1.5 ? '0.5-1.5' : '1.5+'));
bucket('topShare %', (r) => (r.topShare < 30 ? '<30' : r.topShare < 50 ? '30-50' : r.topShare < 70 ? '50-70' : '70+'));
bucket('trades', (r) => (r.trades <= 2 ? '<=2' : r.trades <= 5 ? '3-5' : r.trades <= 10 ? '6-10' : '11+'));
