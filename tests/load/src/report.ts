/** Markdown tables for load-test results. */
import type { OpStats } from './instrument';
import type { JobRun } from './week';

export const f0 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(0)} ms`);

export function table(rows: OpStats[]): string {
  const head = '| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |';
  const sep = '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
  const lines = rows.map(
    (s) =>
      `| ${s.op} | ${s.n} | ${s.errors || ''} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.max)} | ${f0(s.readsAvg)} (${s.readsMax}) | ${f0(s.writesAvg)} (${s.writesMax}) | ${f0(s.rpcsAvg)} | ${s.txRetries || ''} | ${s.fcmTokens || ''} | ${s.tasksEnqueued || ''} |`,
  );
  return [head, sep, ...lines].join('\n');
}

export function jobTable(jobs: JobRun[]): string {
  return [
    '| job | runs | total | avg | max |',
    '|---|---:|---:|---:|---:|',
    ...jobs.map((j) => `| ${j.job} | ${j.runs} | ${ms(j.totalMs)} | ${ms(j.totalMs / j.runs)} | ${ms(j.maxMs)} |`),
  ].join('\n');
}

