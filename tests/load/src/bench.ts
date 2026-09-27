/**
 * Isolated latency benchmark: builds the same hospice world, then runs the
 * operations touched by the performance fixes one at a time (no background
 * load), so latency differences are not hidden by emulator saturation.
 *
 *   npx firebase-tools emulators:exec --only firestore,auth --project demo-auraconnect \
 *     "npm --prefix tests/load run bench -- --label bench-after"
 */
import fs from 'node:fs';
import path from 'node:path';
import { getApps, getFirestore, initializeApp } from './admin';
import { attempt, fakeTextGenerator, installFakes, installFirestoreCounters, resetSamples, summarize } from './instrument';
import { PROJECT, buildWorld, req, resetEmulators } from './world';
import { rng, DAY_MS, HOUR_MS, progress } from './util';
import { table } from './report';
import { generateHandoffHandler } from '../../../functions/src/ai/generateHandoff';
import { generateIdgPrepHandler } from '../../../functions/src/ai/generateIdgPrep';
import { createIdgMeetingHandler } from '../../../functions/src/idg/idg';
import { searchMessagesHandler } from '../../../functions/src/messaging/searchMessages';
import { runDeadlineChecks } from '../../../functions/src/patients/checkDeadlines';
import { recordDeathHandler } from '../../../functions/src/lifecycle/endOfCare';
import { createAlertHandler } from '../../../functions/src/alerts/createAlert';
import { computeMetricsHandler } from '../../../functions/src/metrics/computeMetrics';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function main(): Promise<void> {
  const label = arg('label', 'bench');
  const geminiMs = Number(arg('gemini-ms', '800'));
  if (getApps().length === 0) initializeApp({ projectId: PROJECT });
  installFirestoreCounters();
  installFakes({ fcmLatencyMs: 30, tasksLatencyMs: 15, geminiLatencyMs: geminiMs });
  for (const k of ['log', 'info', 'warn', 'debug', 'error'] as const) console[k] = () => undefined;
  await resetEmulators();
  const r = rng(20260927);
  const w = await buildWorld(r, { historyWeeks: 12, concurrency: 24, acceptConcurrency: 4 });
  resetSamples();
  const gen = fakeTextGenerator(geminiMs);
  const as = <T>(data: T, uid: string) => req(data, w.byUid.get(uid)!, w.orgId);
  const db = getFirestore();
  // A week of fresh patient-channel traffic so handoffs and IDG prep have recent activity.
  const b = db.batch();
  for (const p of w.patients) {
    for (let i = 0; i < 8; i++) {
      b.set(db.collection(`orgs/${w.orgId}/channels/${p.channelId}/messages`).doc(), {
        senderUid: p.rn, senderName: 'RN', body: `pain 3/10 after PRN, family at bedside ${i}`, priority: 'normal', attachments: [],
        roleTarget: null, createdAt: new Date(Date.now() - i * 3 * HOUR_MS), alertId: null,
      });
    }
  }
  await b.commit();

  progress('bench: handoffs');
  for (const rn of w.rns) await attempt('bench:generateHandoff', () => generateHandoffHandler(as({ orgId: w.orgId }, rn.uid), { generator: gen }));

  progress('bench: IDG prep');
  const north = w.patients.filter((p) => p.team === 'north').map((p) => p.id);
  const m = await createIdgMeetingHandler(as({ orgId: w.orgId, title: 'IDG', scheduledAt: new Date().toISOString(), patientIds: north }, w.don.uid));
  await attempt('bench:generateIdgPrep(bulk 25)', () => generateIdgPrepHandler(as({ orgId: w.orgId, meetingId: m.id }, w.don.uid), { generator: gen }));

  progress('bench: search');
  const searches: Array<[string, string, string]> = [
    ['common', 'intake1', 'pain'], ['common', 'rn1', 'family'], ['common', 'don', 'morphine'], ['common', 'intake2', 'oxygen'],
    ['name', 'intake1', w.patients[3]!.last], ['name', 'rn2', w.patients[12]!.last],
    ['rare', 'intake1', 'xylophone'], ['rare', 'rn1', 'tracheostomy'], ['rare', 'intake2', 'zzqv'],
  ];
  for (const [kind, uid, q] of searches) await attempt(`bench:searchMessages(${kind})`, () => searchMessagesHandler(as({ orgId: w.orgId, query: q }, uid)));

  progress('bench: jobs and lifecycle');
  for (let d = 0; d < 3; d++) await attempt('bench:checkDeadlines(job)', () => runDeadlineChecks(new Date(w.weekStartMs + d * DAY_MS + 11 * HOUR_MS), { force: true }));
  for (const p of w.patients.slice(90, 94)) {
    await attempt('bench:recordDeath', () => recordDeathHandler(as({ orgId: w.orgId, patientId: p.id, date: new Date().toISOString().slice(0, 10) }, p.rn)));
  }
  for (const p of w.patients.slice(0, 5)) {
    await attempt('bench:createAlert', () => createAlertHandler(as({ orgId: w.orgId, title: 'Call me', body: '', priority: 'urgent', targetUids: [p.md], patientId: p.id }, p.rn)));
  }
  await attempt('bench:computeMetrics', () => computeMetricsHandler(as({ orgId: w.orgId }, w.owner.uid)));

  const stats = summarize();
  const out = path.resolve(__dirname, '../results');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify({ label, week: stats, setup: [], jobs: [] }, null, 2));
  const md = `# ${label} (sequential, no background load; Gemini fake ${geminiMs} ms)\n\n${table(stats)}\n`;
  fs.writeFileSync(path.join(out, `${label}.md`), md);
  process.stdout.write(md);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`bench failed: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
