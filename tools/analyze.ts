// Data analysis (research only): where, if anywhere, is the edge in early pump.fun launches?
// For every universe coin, record the create price and the price N slots later, then print
// the distribution of price changes at several horizons. Also: for the coins the current
// strategy buys, what is the price path after entry?

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
  p0: number; // create price vq/vt
  bySlot: Map<number, number>; // slot -> price after that slot's trades
  lastSlot: number;
}
const coins = new Map<string, CoinPath>();
for (const e of events) {
  if (!universe.has(e.mint)) continue;
  if (e.event === 'CreateEvent') {
    coins.set(e.mint, {
      mint: e.mint,
      createSlot: e.slot,
      p0: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
      bySlot: new Map(),
      lastSlot: e.slot,
    });
  } else if (e.event === 'TradeEvent') {
    const c = coins.get(e.mint);
    if (!c) continue;
    c.bySlot.set(e.slot, Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves));
    c.lastSlot = e.slot;
  }
}

function priceAt(c: CoinPath, slot: number): number | null {
  // last recorded price at or before `slot`
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

const horizons = [2, 6, 12, 30, 120, 600, 3600];
console.log(`universe coins: ${coins.size}`);
for (const h of horizons) {
  const changes: number[] = [];
  let up5 = 0;
  let up20 = 0;
  let up50 = 0;
  for (const c of coins.values()) {
    const p = priceAt(c, c.createSlot + h);
    if (p === null) continue;
    const ch = p / c.p0 - 1;
    changes.push(ch);
    if (ch > 0.05) up5++;
    if (ch > 0.2) up20++;
    if (ch > 0.5) up50++;
  }
  changes.sort((a, b) => a - b);
  const n = changes.length;
  const mean = changes.reduce((a, b) => a + b, 0) / n;
  const med = changes[Math.floor(n / 2)]!;
  const p90 = changes[Math.floor(n * 0.9)]!;
  console.log(
    `+${String(h).padStart(4)} slots: n=${n} mean ${(mean * 100).toFixed(1)}% median ${(med * 100).toFixed(1)}% p90 ${(p90 * 100).toFixed(1)}% ` +
      `up>5% ${up5} (${((up5 / n) * 100).toFixed(0)}%) up>20% ${up20} up>50% ${up50}`,
  );
}
// Same, but measured from the price 2 slots after create (our fill price, roughly).
console.log('\nFrom fill price (create+2 slots):');
for (const h of [4, 10, 28, 118, 598]) {
  const changes: number[] = [];
  let up5 = 0;
  let up20 = 0;
  for (const c of coins.values()) {
    const pFill = priceAt(c, c.createSlot + 2);
    const p = priceAt(c, c.createSlot + 2 + h);
    if (pFill === null || p === null) continue;
    const ch = p / pFill - 1;
    changes.push(ch);
    if (ch > 0.05) up5++;
    if (ch > 0.2) up20++;
  }
  changes.sort((a, b) => a - b);
  const n = changes.length;
  const mean = changes.reduce((a, b) => a + b, 0) / n;
  const med = changes[Math.floor(n / 2)]!;
  console.log(`+${String(h).padStart(4)} slots after fill: n=${n} mean ${(mean * 100).toFixed(1)}% median ${(med * 100).toFixed(1)}% up>5% ${up5} up>20% ${up20}`);
}
