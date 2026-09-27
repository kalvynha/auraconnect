/**
 * Before/after comparison of two load-test result files.
 *   npm --prefix tests/load run compare -- baseline after
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OpStats } from './instrument';
import type { Results } from './run';

const [a = 'baseline', b = 'after', ...rest] = process.argv.slice(2);
const only = rest.length ? new Set(rest) : null;
const load = (label: string): Results => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../results', `${label}.json`), 'utf8'));
const A = load(a);
const B = load(b);

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(0)} ms`);
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const arrow = (x: string, y: string) => (x === y ? x : `${x} → ${y}`);

const rows: string[] = [
  `| operation | n | p50 | p95 | max | reads avg (max) | writes avg | rpcs avg | tx retries | errors |`,
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
];
const byOp = (list: OpStats[]) => new Map(list.map((s) => [s.op, s]));
const bm = byOp(B.week);
for (const s of A.week) {
  const t = bm.get(s.op);
  if (!t || (only && !only.has(s.op))) continue;
  rows.push(
    `| ${s.op} | ${arrow(String(s.n), String(t.n))} | ${arrow(ms(s.p50), ms(t.p50))} | ${arrow(ms(s.p95), ms(t.p95))} | ${arrow(ms(s.max), ms(t.max))} | ${arrow(`${num(s.readsAvg)} (${s.readsMax})`, `${num(t.readsAvg)} (${t.readsMax})`)} | ${arrow(num(s.writesAvg), num(t.writesAvg))} | ${arrow(num(s.rpcsAvg), num(t.rpcsAvg))} | ${arrow(String(s.txRetries), String(t.txRetries))} | ${arrow(String(s.errors), String(t.errors))} |`,
  );
}
const jobs = ['| job | runs | total | avg | max |', '|---|---:|---:|---:|---:|'];
const jb = new Map(B.jobs.map((j) => [j.job, j]));
for (const j of A.jobs) {
  const k = jb.get(j.job);
  if (!k) continue;
  jobs.push(`| ${j.job} | ${j.runs} | ${arrow(ms(j.totalMs), ms(k.totalMs))} | ${arrow(ms(j.totalMs / j.runs), ms(k.totalMs / k.runs))} | ${arrow(ms(j.maxMs), ms(k.maxMs))} |`);
}
const setupRows = ['| setup op | p50 | p95 | max | tx retries | errors |', '|---|---:|---:|---:|---:|---:|'];
const sb = byOp(B.setup);
for (const s of A.setup) {
  const t = sb.get(s.op);
  if (!t) continue;
  setupRows.push(`| ${s.op} | ${arrow(ms(s.p50), ms(t.p50))} | ${arrow(ms(s.p95), ms(t.p95))} | ${arrow(ms(s.max), ms(t.max))} | ${arrow(String(s.txRetries), String(t.txRetries))} | ${arrow(String(s.errors), String(t.errors))} |`);
}
const out = [`# ${a} → ${b}`, '', rows.join('\n'), '', jobs.join('\n'), '', setupRows.join('\n')].join('\n');
fs.writeFileSync(path.resolve(__dirname, '../results', `compare-${a}-${b}.md`), out);
process.stdout.write(`${out}\n`);
