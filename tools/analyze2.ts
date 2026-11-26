// Data analysis 2: does continued buying AFTER the initial spike predict forward returns?
// For each universe coin: r1 = price move from create+2 to create+8 (early continuation),
// r2 = price move from create+8 to create+30 (forward return). Bucket by r1 and by the
// number of distinct buyers arriving in slots 3..8, and print mean forward returns.

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
  bySlot: Map<number, number>;
  trades: { slot: number; isBuy: boolean; sol: bigint; user: string }[];
}
const coins = new Map<string, CoinPath>();
for (const e of events) {
  if (!universe.has(e.mint)) continue;
  if (e.event === 'CreateEvent') {
    coins.set(e.mint, { mint: e.mint, createSlot: e.slot, creator: e.creator, bySlot: new Map(), trades: [] });
  } else if (e.event === 'TradeEvent') {
    const c = coins.get(e.mint);
    if (!c) continue;
    c.bySlot.set(e.slot, Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves));
    c.trades.push({ slot: e.slot, isBuy: e.is_buy, sol: BigInt(e.sol_amount), user: e.user });
  }
}
function priceAt(c: CoinPath, slot: number): number | null {
  let best: number | null = null;
  let bestSlot = -1;
  for (const [s, p] of c.bySlot) {
    if (s <= slot && s > bestSlot) {
      bestSlot = s;
      best = p;
    }
  }
  return best;
}

interface Row {
  r1: number;
  r2: number;
  lateBuyers: number;
  lateNet: number;
  lateTrades: number;
}
const rows: Row[] = [];
for (const c of coins.values()) {
  const p2 = priceAt(c, c.createSlot + 2);
  const p8 = priceAt(c, c.createSlot + 8);
  const p30 = priceAt(c, c.createSlot + 30);
  if (p2 === null || p8 === null || p30 === null) continue;
  const late = c.trades.filter((t) => t.slot > c.createSlot + 2 && t.slot <= c.createSlot + 8);
  const buyers = new Set(late.filter((t) => t.isBuy && t.user !== c.creator).map((t) => t.user));
  let net = 0n;
  for (const t of late) net += t.isBuy ? t.sol : -t.sol;
  rows.push({
    r1: p8 / p2 - 1,
    r2: p30 / p8 - 1,
    lateBuyers: buyers.size,
    lateNet: Number(net) / 1e9,
    lateTrades: late.length,
  });
}
console.log(`coins with full path: ${rows.length}`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const buckets: [string, (r: Row) => boolean][] = [
  ['r1 < -10%', (r) => r.r1 < -0.1],
  ['-10% <= r1 < -2%', (r) => r.r1 >= -0.1 && r.r1 < -0.02],
  ['-2% <= r1 < +2%', (r) => r.r1 >= -0.02 && r.r1 < 0.02],
  ['+2% <= r1 < +10%', (r) => r.r1 >= 0.02 && r.r1 < 0.1],
  ['+10% <= r1 < +30%', (r) => r.r1 >= 0.1 && r.r1 < 0.3],
  ['r1 >= +30%', (r) => r.r1 >= 0.3],
];
for (const [label, f] of buckets) {
  const rs = rows.filter(f);
  const r2 = rs.map((r) => r.r2);
  const wins = r2.filter((x) => x > 0.05).length;
  console.log(`${label.padEnd(18)} n=${String(rs.length).padStart(4)}  mean r2 ${(mean(r2) * 100).toFixed(1)}%  median ${(r2.sort((a, b) => a - b)[Math.floor(r2.length / 2)]! * 100).toFixed(1)}%  up>5% ${wins}`);
}
console.log('\nBy late distinct buyers (slots 3..8):');
for (const [label, f] of [
  ['0 buyers', (r: Row) => r.lateBuyers === 0],
  ['1-2 buyers', (r: Row) => r.lateBuyers >= 1 && r.lateBuyers <= 2],
  ['3-5 buyers', (r: Row) => r.lateBuyers >= 3 && r.lateBuyers <= 5],
  ['6+ buyers', (r: Row) => r.lateBuyers >= 6],
] as [string, (r: Row) => boolean][]) {
  const rs = rows.filter(f);
  const r2 = rs.map((r) => r.r2);
  console.log(`${label.padEnd(12)} n=${String(rs.length).padStart(4)}  mean r2 ${(mean(r2) * 100).toFixed(1)}%  up>5% ${r2.filter((x) => x > 0.05).length}`);
}
console.log('\nBy late net flow (slots 3..8, SOL):');
for (const [label, f] of [
  ['net < 0', (r: Row) => r.lateNet < 0],
  ['0 <= net < 0.1', (r: Row) => r.lateNet >= 0 && r.lateNet < 0.1],
  ['0.1 <= net < 0.5', (r: Row) => r.lateNet >= 0.1 && r.lateNet < 0.5],
  ['net >= 0.5', (r: Row) => r.lateNet >= 0.5],
] as [string, (r: Row) => boolean][]) {
  const rs = rows.filter(f);
  const r2 = rs.map((r) => r.r2);
  console.log(`${label.padEnd(16)} n=${String(rs.length).padStart(4)}  mean r2 ${(mean(r2) * 100).toFixed(1)}%  up>5% ${r2.filter((x) => x > 0.05).length}`);
}
// Combined signal: r1 > +2% AND lateBuyers >= 3
const combo = rows.filter((r) => r.r1 >= 0.02 && r.lateBuyers >= 3);
console.log(`\nCOMBO r1>=+2% and lateBuyers>=3: n=${combo.length} mean r2 ${(mean(combo.map((r) => r.r2)) * 100).toFixed(1)}% up>5% ${combo.filter((r) => r.r2 > 0.05).length} up>20% ${combo.filter((r) => r.r2 > 0.2).length}`);
const combo2 = rows.filter((r) => r.r1 >= 0.02 && r.lateBuyers >= 3 && r.lateNet >= 0.1);
console.log(`COMBO + lateNet>=0.1: n=${combo2.length} mean r2 ${(mean(combo2.map((r) => r.r2)) * 100).toFixed(1)}% up>5% ${combo2.filter((r) => r.r2 > 0.05).length} up>20% ${combo2.filter((r) => r.r2 > 0.2).length}`);
