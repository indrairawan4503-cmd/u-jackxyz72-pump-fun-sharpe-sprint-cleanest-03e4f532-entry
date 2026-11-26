// Parameter sweep over tools/sim.ts: every combination of the given values, ranked by
// hourly Sharpe (then net PnL). A setting that wins only in one window half is a fluke,
// not an edge, so both halves print.
//
//   node tools/grid.ts '{"tpBps":[800,1200],"slBps":[600,1000]}' [--base '{"maxAge":6}'] [--top 20] [--kit <dir>]
//
// Keep grids small: each combination replays the full 24h dev window in-process.

import { simulate } from './sim.ts';
import { DEFAULT_PARAMS, type Params } from '../strategy.ts';

const args = process.argv.slice(2);
const get = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const kit = get('--kit') ?? '/Users/toor/.agentfun/pilot/kit-dev/pilot-pumpfun-replay-kit';
const grid: Record<string, unknown[]> = JSON.parse(args[0] ?? '{}');
const base: Params = { ...DEFAULT_PARAMS, ...JSON.parse(get('--base') ?? '{}') };
const top = Number(get('--top') ?? '25');

let combos: Record<string, unknown>[] = [{}];
for (const [k, vs] of Object.entries(grid)) combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })));

interface Row {
  label: string;
  sharpe: number;
  net: number;
  h0: number;
  h1: number;
  fills: number;
  mints: number;
  rt: number;
  win: number;
  top3: number;
  dd: number;
}
const rows: Row[] = [];
for (const c of combos) {
  const r = simulate(kit, { ...base, ...c } as Params);
  rows.push({
    label: JSON.stringify(c),
    sharpe: r.sharpePop,
    net: Number(r.net) / 1e9,
    h0: Number(r.halves[0]) / 1e9,
    h1: Number(r.halves[1]) / 1e9,
    fills: r.fills,
    mints: r.mints,
    rt: r.roundTripsBig,
    win: r.winRate,
    top3: r.top3Share,
    dd: r.maxDD,
  });
  console.log(
    `sharpe ${rows[rows.length - 1]!.sharpe.toFixed(3)}  net ${rows[rows.length - 1]!.net.toFixed(3)}  ` +
      `[${rows[rows.length - 1]!.h0.toFixed(3)} ${rows[rows.length - 1]!.h1.toFixed(3)}]  ` +
      `fills ${rows[rows.length - 1]!.fills} mints ${rows[rows.length - 1]!.mints} rt ${rows[rows.length - 1]!.rt} ` +
      `win ${(rows[rows.length - 1]!.win * 100).toFixed(0)}% top3 ${rows[rows.length - 1]!.top3.toFixed(2)} ` +
      `dd ${(rows[rows.length - 1]!.dd * 100).toFixed(1)}%  ${rows[rows.length - 1]!.label}`,
  );
}
rows.sort((a, b) => b.sharpe - a.sharpe || b.net - a.net);
console.log(`\nTOP ${Math.min(top, rows.length)} by Sharpe:`);
for (const r of rows.slice(0, top)) {
  console.log(
    `sharpe ${r.sharpe.toFixed(3)}  net ${r.net.toFixed(3)}  [${r.h0.toFixed(3)} ${r.h1.toFixed(3)}]  ` +
      `fills ${r.fills} mints ${r.mints} rt ${r.rt} win ${(r.win * 100).toFixed(0)}% top3 ${r.top3.toFixed(2)} dd ${(r.dd * 100).toFixed(1)}%  ${r.label}`,
  );
}
console.log(`${combos.length} combos`);
