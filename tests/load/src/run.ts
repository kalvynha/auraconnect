/**
 * AuraConnect hospice-scale load test (ADC 100, ~70 staff, one busy week).
 *
 * Runs the real Cloud Functions handlers (imported from functions/src) against
 * the Firestore and Auth emulators, with FCM, Cloud Tasks and Gemini faked.
 *
 * From the repo root:
 *   npx firebase-tools emulators:exec --only firestore,auth --project demo-auraconnect \
 *     "npm --prefix tests/load start -- --label baseline"
 *
 * Options: --label NAME (results/NAME.json|md), --history-weeks N (default 12),
 * --concurrency N (default 24), --accept-concurrency N (invite acceptance, default 4), --gemini-ms N (default 800), --messages N (default 5000),
 * --seed N, --no-purge, --no-v4-prefs (skip the v4 muted-channel / mention scenario).
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getApps, initializeApp } from './admin';
import { fakeTotals, installFakes, installFirestoreCounters, resetSamples, summarize, unattributed, errors, type OpStats } from './instrument';
import { PROJECT, buildWorld, resetEmulators } from './world';
import { runWeek, type JobRun } from './week';
import { progress, rng } from './util';
import { jobTable, ms, table } from './report';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

export interface Results {
  label: string;
  startedAt: string;
  config: Record<string, unknown>;
  wallMs: { setup: number; week: number };
  setup: OpStats[];
  week: OpStats[];
  jobs: JobRun[];
  fakes: typeof fakeTotals;
  unattributed: typeof unattributed;
  errors: Record<string, Record<string, number>>;
}

async function main(): Promise<void> {
  const label = arg('label', 'run');
  const config = {
    seed: Number(arg('seed', '20260927')),
    historyWeeks: Number(arg('history-weeks', '12')),
    concurrency: Number(arg('concurrency', '24')),
    acceptConcurrency: Number(arg('accept-concurrency', '4')),
    geminiLatencyMs: Number(arg('gemini-ms', '800')),
    messagesPerWeek: Number(arg('messages', '5000')),
    fcmLatencyMs: 30,
    tasksLatencyMs: 15,
    purge: !process.argv.includes('--no-purge'),
    v4Prefs: !process.argv.includes('--no-v4-prefs'),
  };
  if (getApps().length === 0) initializeApp({ projectId: PROJECT });
  installFirestoreCounters();
  installFakes(config);

  // Keep the functions' structured logs out of the report (they go to a log file instead).
  const outDir = path.resolve(__dirname, '../results');
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = fs.createWriteStream(path.join(outDir, `${label}.log`));
  for (const k of ['log', 'info', 'warn', 'debug', 'error'] as const) {
    console[k] = (...a: unknown[]) => void logFile.write(`${k} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
  }

  const r = rng(config.seed);
  await resetEmulators();
  const t0 = performance.now();
  const world = await buildWorld(r, config);
  const setupMs = performance.now() - t0;
  const setup = summarize();
  resetSamples();

  const t1 = performance.now();
  const jobs = await runWeek(world, r, config);
  const weekMs = performance.now() - t1;
  const week = summarize();

  const res: Results = {
    label,
    startedAt: new Date().toISOString(),
    config,
    wallMs: { setup: setupMs, week: weekMs },
    setup,
    week,
    jobs,
    fakes: fakeTotals,
    unattributed,
    errors: Object.fromEntries([...errors].map(([k, v]) => [k, Object.fromEntries(v)])),
  };
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(res, null, 2));
  const md = [
    `# Load test: ${label}`,
    '',
    `Config: ${JSON.stringify(config)}  `,
    `Wall time: setup ${ms(setupMs)}, week ${ms(weekMs)}. Fakes: ${JSON.stringify(fakeTotals)}`,
    '',
    '## Busy week (per operation)',
    '',
    table(week),
    '',
    '## Scheduled jobs',
    '',
    jobTable(jobs),
    '',
    '## Setup',
    '',
    table(setup),
    '',
    '## Errors',
    '',
    '```',
    JSON.stringify(res.errors, null, 2),
    '```',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, `${label}.md`), md);
  process.stdout.write(`${md}\n`);
  logFile.end();
  progress(`done; results in ${path.relative(process.cwd(), outDir)}/${label}.{json,md}`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`load test failed: ${(e as Error).stack ?? e}\n`);
  process.stderr.write(`recorded errors: ${JSON.stringify(Object.fromEntries([...errors].map(([k, v]) => [k, Object.fromEntries(v)])), null, 2)}\n`);
  process.exit(1);
});
