/**
 * Per-operation instrumentation.
 *
 * Every measured operation runs inside an AsyncLocalStorage context. Thin
 * wrappers around the Firestore client's internal read/commit entry points
 * attribute billable document reads and writes to whichever operation is
 * running, even with many operations in flight at once:
 *
 *  - reads:  DocumentReader._get (doc get / getAll / tx.get / tx.getAll): 1 per document
 *            Query._get (query get, in or out of a transaction): max(1, docs returned)
 *            AggregateQuery._get (count()):                        max(1, ceil(count / 1000))
 *  - writes: WriteBatch._commit (set/update/create/delete, batches, transaction commits):
 *            1 per operation in a *successful* commit
 *  - rpcs:   round trips for the above (a rough "how chatty is it" signal)
 *  - txRuns / txAttempts: runTransaction calls and update-function attempts (attempts − runs = retries)
 *
 * This mirrors Firestore billing closely enough to find hotspots. (Listener
 * reads are not counted; the harness's trigger pumps use listeners.)
 *
 * FCM, Cloud Tasks and Gemini are replaced with fakes that count calls.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { GCF_FIRESTORE_SRC, getFunctions, getMessaging } from './admin';

export interface Counters {
  reads: number;
  writes: number;
  rpcs: number;
  txRuns: number;
  txAttempts: number;
  fcmCalls: number;
  fcmTokens: number;
  tasksEnqueued: number;
  geminiCalls: number;
}

export const zero = (): Counters => ({ reads: 0, writes: 0, rpcs: 0, txRuns: 0, txAttempts: 0, fcmCalls: 0, fcmTokens: 0, tasksEnqueued: 0, geminiCalls: 0 });

const als = new AsyncLocalStorage<Counters>();
/** Work done outside any measured operation (seeding, harness bookkeeping, trigger payload reads). */
export const unattributed = zero();
const cur = (): Counters => als.getStore() ?? unattributed;

// ---------------------------------------------------------------------------
// Firestore read/write counting
// ---------------------------------------------------------------------------

let installed = false;
export function installFirestoreCounters(): void {
  if (installed) return;
  installed = true;
  const root = path.resolve(__dirname, GCF_FIRESTORE_SRC);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const load = (p: string) => require(path.join(root, p));

  const DocumentReader = load('document-reader.js').DocumentReader;
  const readerGet = DocumentReader.prototype._get;
  DocumentReader.prototype._get = function (this: { allDocuments: unknown[] }, ...args: unknown[]) {
    const c = cur();
    c.rpcs++;
    c.reads += this.allDocuments.length;
    return readerGet.apply(this, args);
  };

  const Query = load('reference/query.js').Query;
  const queryGet = Query.prototype._get;
  Query.prototype._get = async function (this: unknown, ...args: unknown[]) {
    const c = cur();
    const res = await queryGet.apply(this, args);
    c.rpcs++;
    c.reads += Math.max(1, res.result.size);
    return res;
  };

  const AggregateQuery = load('reference/aggregate-query.js').AggregateQuery;
  const aggGet = AggregateQuery.prototype._get;
  AggregateQuery.prototype._get = async function (this: unknown, ...args: unknown[]) {
    const c = cur();
    const res = await aggGet.apply(this, args);
    const n = Number(res.result.data().count ?? 0);
    c.rpcs++;
    c.reads += Math.max(1, Math.ceil(n / 1000));
    return res;
  };

  const WriteBatch = load('write-batch.js').WriteBatch;
  const commit = WriteBatch.prototype._commit;
  WriteBatch.prototype._commit = async function (this: { _ops: unknown[] }, ...args: unknown[]) {
    const c = cur();
    const n = this._ops.length;
    c.rpcs++;
    const res = await commit.apply(this, args);
    c.writes += n;
    return res;
  };

  const Firestore = load('index.js').Firestore;
  const runTx = Firestore.prototype.runTransaction;
  Firestore.prototype.runTransaction = function (this: unknown, fn: (tx: unknown) => Promise<unknown>, opts?: unknown) {
    const c = cur();
    c.txRuns++;
    return runTx.call(this, (tx: unknown) => {
      c.txAttempts++;
      return fn(tx);
    }, opts);
  };
}

// ---------------------------------------------------------------------------
// Fakes: FCM, Cloud Tasks, Gemini
// ---------------------------------------------------------------------------

export interface FakeConfig {
  fcmLatencyMs: number;
  tasksLatencyMs: number;
  geminiLatencyMs: number;
}

export interface EnqueuedTask {
  payload: { orgId: string; alertId: string; expectedLevel: number };
  delaySeconds: number;
  id: string;
}

export const fakeTotals = { fcmCalls: 0, fcmTokens: 0, tasksEnqueued: 0, geminiCalls: 0 };
/** Escalation checks waiting to be "dispatched" by the harness. */
export const taskQueue: EnqueuedTask[] = [];
const seenTaskIds = new Set<string>();

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function installFakes(cfg: FakeConfig): void {
  const messaging = getMessaging() as unknown as Record<string, unknown>;
  messaging.sendEachForMulticast = async (msg: { tokens: string[] }) => {
    const c = cur();
    c.fcmCalls++;
    c.fcmTokens += msg.tokens.length;
    fakeTotals.fcmCalls++;
    fakeTotals.fcmTokens += msg.tokens.length;
    await sleep(cfg.fcmLatencyMs);
    return { successCount: msg.tokens.length, failureCount: 0, responses: msg.tokens.map(() => ({ success: true })) };
  };

  const queueProto = Object.getPrototypeOf(getFunctions().taskQueue('locations/us-central1/functions/escalateAlert')) as Record<string, unknown>;
  queueProto.enqueue = async (payload: EnqueuedTask['payload'], opts: { scheduleDelaySeconds?: number; id?: string } = {}) => {
    const c = cur();
    await sleep(cfg.tasksLatencyMs);
    const id = opts.id ?? `${payload.alertId}-${payload.expectedLevel}`;
    if (seenTaskIds.has(id)) {
      const err = new Error('task exists') as Error & { code: string };
      err.code = 'functions/task-already-exists';
      throw err;
    }
    seenTaskIds.add(id);
    c.tasksEnqueued++;
    fakeTotals.tasksEnqueued++;
    taskQueue.push({ payload, delaySeconds: opts.scheduleDelaySeconds ?? 0, id });
  };
}

/** Fake Gemini text generator (summaries, handoffs, IDG prep) with a fixed latency. */
export function fakeTextGenerator(latencyMs: number) {
  return {
    async generate(input: { prompt: string }) {
      const c = cur();
      c.geminiCalls++;
      fakeTotals.geminiCalls++;
      await sleep(latencyMs);
      return { text: `- Summary of ${input.prompt.length} prompt chars (fake model).`, model: 'fake-gemini' };
    },
  };
}

/** Fake referral extractor returning a plausible extraction. */
export function fakeExtractor(latencyMs: number) {
  return {
    async extract() {
      const c = cur();
      c.geminiCalls++;
      fakeTotals.geminiCalls++;
      await sleep(latencyMs);
      return {
        model: 'fake-gemini',
        raw: {
          patient: { firstName: 'Ref', lastName: 'Erral', dob: '1941-02-03', sex: 'female', codeStatus: 'DNR', medications: [{ name: 'Morphine', dose: '5 mg', route: 'PO', frequency: 'q4h PRN' }] },
          referralDate: '2026-09-20',
          referralSource: 'General Hospital',
          reasonForReferral: 'End-stage COPD',
          fieldConfidence: [{ path: 'patient.lastName', confidence: 0.95 }, { path: 'patient.dob', confidence: 0.6 }],
          warnings: [],
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface Sample {
  ms: number;
  ok: boolean;
  c: Counters;
}

export const samples = new Map<string, Sample[]>();
export const errors = new Map<string, Map<string, number>>();

/** Runs `fn` as operation `op`, recording latency and attributed counters. Rethrows errors. */
export async function measure<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const c = zero();
  const t0 = performance.now();
  let ok = true;
  try {
    return await als.run(c, fn);
  } catch (e) {
    ok = false;
    const msg = `${(e as { code?: string }).code ?? ''} ${(e as Error).message ?? e}`.trim().slice(0, 160);
    const m = errors.get(op) ?? new Map<string, number>();
    m.set(msg, (m.get(msg) ?? 0) + 1);
    errors.set(op, m);
    throw e;
  } finally {
    const list = samples.get(op) ?? [];
    list.push({ ms: performance.now() - t0, ok, c });
    samples.set(op, list);
  }
}

/** Like {@link measure} but swallows the error (it is still recorded). */
export async function attempt<T>(op: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await measure(op, fn);
  } catch {
    return undefined;
  }
}

export interface OpStats {
  op: string;
  n: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  totalMs: number;
  readsAvg: number;
  readsMax: number;
  writesAvg: number;
  writesMax: number;
  rpcsAvg: number;
  readsTotal: number;
  writesTotal: number;
  txRetries: number;
  fcmCalls: number;
  fcmTokens: number;
  tasksEnqueued: number;
  geminiCalls: number;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function summarize(): OpStats[] {
  const out: OpStats[] = [];
  for (const [op, list] of samples) {
    const ms = list.map((s) => s.ms).sort((a, b) => a - b);
    const sum = (f: (c: Counters) => number) => list.reduce((a, s) => a + f(s.c), 0);
    const max = (f: (c: Counters) => number) => list.reduce((a, s) => Math.max(a, f(s.c)), 0);
    out.push({
      op,
      n: list.length,
      errors: list.filter((s) => !s.ok).length,
      p50: pct(ms, 50),
      p95: pct(ms, 95),
      max: ms[ms.length - 1] ?? 0,
      totalMs: ms.reduce((a, b) => a + b, 0),
      readsAvg: sum((c) => c.reads) / list.length,
      readsMax: max((c) => c.reads),
      writesAvg: sum((c) => c.writes) / list.length,
      writesMax: max((c) => c.writes),
      rpcsAvg: sum((c) => c.rpcs) / list.length,
      readsTotal: sum((c) => c.reads),
      writesTotal: sum((c) => c.writes),
      txRetries: sum((c) => c.txAttempts - c.txRuns),
      fcmCalls: sum((c) => c.fcmCalls),
      fcmTokens: sum((c) => c.fcmTokens),
      tasksEnqueued: sum((c) => c.tasksEnqueued),
      geminiCalls: sum((c) => c.geminiCalls),
    });
  }
  return out.sort((a, b) => a.op.localeCompare(b.op));
}

export function resetSamples(): void {
  samples.clear();
  errors.clear();
}

/**
 * Retries like a user pressing the button again (up to `tries` attempts, linear backoff).
 * Every failed attempt is still recorded under `op`. Returns undefined if all attempts failed.
 */
export async function retrying<T>(op: string, fn: () => Promise<T>, tries = 8): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    try {
      return await measure(op, fn);
    } catch {
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  return undefined;
}
