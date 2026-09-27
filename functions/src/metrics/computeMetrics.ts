/**
 * Dashboard metrics writers.
 *  - `computeDailyMetrics`: hourly; each org is processed in its local 01:00
 *    hour and gets `metrics/{yesterday}` (org-local date).
 *  - `computeMetrics`: admin callable; computes today's (partial-day) metrics,
 *    writes `metrics/{today}` and returns them.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { z } from 'zod';
import { addDays, localDateParts } from '../domain/dates';
import { computeDailyMetricsValues } from '../domain/metrics';
import { parse, requireOrg } from '../lib/context';
import { db, docRef, getDocData, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type { ComputeMetricsRequest, ComputeMetricsResponse, DailyMetrics, ISODate, Org } from '../shared/types';
import { loadMetricsInput } from './loadMetricsInput';

/** Local hour at which yesterday's metrics are computed. */
export const METRICS_LOCAL_HOUR = 1;

export function metricsPath(orgId: string, date: ISODate): string {
  return `${paths.org(orgId)}/metrics/${date}`;
}

/** Computes and writes `metrics/{date}` for one org. */
export async function computeAndStoreMetrics(orgId: string, org: Pick<Org, 'timezone'>, date: ISODate): Promise<DailyMetrics> {
  const values = computeDailyMetricsValues(await loadMetricsInput(orgId, org, date));
  const metrics: DailyMetrics = { ...values, computedAt: Timestamp.now() };
  await docRef(metricsPath(orgId, date)).set(metrics as unknown as Record<string, unknown>);
  return metrics;
}

/** Processes every org whose local hour is {@link METRICS_LOCAL_HOUR} (or all with `force`). */
export async function runDailyMetrics(now: Date, opts: { force?: boolean } = {}): Promise<{ orgs: number; failed: number }> {
  const orgs = await db().collection('orgs').get();
  let processed = 0;
  let failed = 0;
  for (const doc of orgs.docs) {
    const org = doc.data() as Org;
    const local = localDateParts(now, org.timezone);
    if (!opts.force && local.hour !== METRICS_LOCAL_HOUR) continue;
    try {
      await computeAndStoreMetrics(doc.id, org, addDays(local.date, -1));
      processed++;
    } catch (e) {
      failed++;
      logger.error('daily metrics failed for org', { orgId: doc.id, code: (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'unknown' });
    }
  }
  return { orgs: processed, failed };
}

export const computeDailyMetrics = onSchedule(
  { schedule: '5 * * * *', timeZone: 'UTC', timeoutSeconds: 540, memory: '512MiB', retryCount: 1 },
  async () => {
    const res = await runDailyMetrics(new Date());
    logger.info('daily metrics complete', res);
  },
);

const schema = z.object({ orgId: id });

export async function computeMetricsHandler(request: CallableRequest<ComputeMetricsRequest>): Promise<ComputeMetricsResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, ['admin']);
  const org = await getDocData<Org>(paths.org(ctx.orgId));
  const tz = org?.timezone ?? 'UTC';
  const today = localDateParts(new Date(), tz).date;
  const metrics = await computeAndStoreMetrics(ctx.orgId, { timezone: tz }, today);
  // Plain {seconds, nanoseconds} so the callable response matches TimestampLike.
  return { metrics: { ...metrics, computedAt: { seconds: metrics.computedAt.seconds, nanoseconds: metrics.computedAt.nanoseconds } } };
}

export const computeMetrics = onCall({ timeoutSeconds: 120 }, computeMetricsHandler);
