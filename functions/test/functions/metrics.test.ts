import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));

import { fakeDb, Timestamp } from '../fakes/firestore';
import { computeMetricsHandler, runDailyMetrics } from '../../src/metrics/computeMetrics';
import { ORG, req, seedOrg } from './helpers';

const t = (iso: string) => Timestamp.fromMillis(Date.parse(iso));

beforeEach(() => seedOrg());

function seedDay() {
  fakeDb.seed(`orgs/${ORG}/patients/p1`, { status: 'admitted', levelOfCare: 'continuous', milestones: null });
  fakeDb.seed(`orgs/${ORG}/patients/p2`, { status: 'referral' });
  fakeDb.seed(`orgs/${ORG}/patients/p3`, { status: 'deceased', death: { date: '2026-09-25' } });
  fakeDb.seed(`orgs/${ORG}/alerts/a1`, { createdAt: t('2026-09-25T10:00:00Z'), ackedAt: t('2026-09-25T10:06:00Z'), exhausted: false });
  fakeDb.seed(`orgs/${ORG}/alerts/a2`, { createdAt: t('2026-09-24T10:00:00Z'), ackedAt: null, exhausted: true }); // other day
  fakeDb.seed(`orgs/${ORG}/visits/v1`, { status: 'completed', scheduledStart: t('2026-09-25T15:00:00Z') });
  fakeDb.seed(`orgs/${ORG}/visits/v2`, { status: 'missed', scheduledStart: t('2026-09-25T23:59:00Z') });
  fakeDb.seed(`orgs/${ORG}/visits/v3`, { status: 'completed', scheduledStart: t('2026-09-26T00:00:00Z') }); // next day
  fakeDb.seed(`orgs/${ORG}/triageCalls/c1`, { urgency: 'emergent', receivedAt: t('2026-09-25T02:00:00Z'), resolvedAt: t('2026-09-25T02:20:00Z') });
  fakeDb.seed(`orgs/${ORG}/volunteerLogs/l1`, { volunteerUid: 'b', date: '2026-09-20', minutes: 45 });
  fakeDb.seed(`orgs/${ORG}/volunteerAssignments/va1`, { status: 'active' });
  fakeDb.seed(`orgs/${ORG}/volunteerAssignments/va2`, { status: 'ended' });
  fakeDb.seed(`orgs/${ORG}/bereavementPlans/b1`, { status: 'active', contacts: [{ dueDate: '2026-09-28', status: 'pending' }] });
}

describe('runDailyMetrics', () => {
  it('processes orgs at 01:00 local time and writes metrics/{yesterday}', async () => {
    seedDay();
    expect(await runDailyMetrics(new Date('2026-09-26T05:00:00Z'))).toEqual({ orgs: 0, failed: 0 });
    expect(await runDailyMetrics(new Date('2026-09-26T01:10:00Z'))).toEqual({ orgs: 1, failed: 0 });
    const m = fakeDb.read<any>(`orgs/${ORG}/metrics/2026-09-25`)!;
    expect(m).toMatchObject({
      date: '2026-09-25',
      census: { admitted: 1, referral: 1, dischargedToday: 0, deathsToday: 1 },
      levelOfCare: { routine: 0, continuous: 1, respite: 0, gip: 0 },
      alerts: { created: 1, acked: 1, medianAckMinutes: 6, exhausted: 0 },
      visits: { scheduled: 0, completed: 1, missed: 1, cancelled: 0 },
      triage: { calls: 1, emergent: 1, medianResolveMinutes: 20 },
      volunteers: { minutesLast30d: 45, activeAssignments: 1 },
      bereavement: { activePlans: 1, contactsDueNext7Days: 1, contactsOverdue: 0 },
    });
    expect(m.computedAt).toBeInstanceOf(Timestamp);
  });
});

describe('computeMetrics', () => {
  it('is admin-only and writes/returns today', async () => {
    await expect(computeMetricsHandler(req({ orgId: ORG }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(computeMetricsHandler(req({ orgId: 'other' }, { uid: 'a', role: 'admin' }))).rejects.toMatchObject({ code: 'permission-denied' });
    const today = new Date().toISOString().slice(0, 10);
    const { metrics } = await computeMetricsHandler(req({ orgId: ORG }, { uid: 'a', role: 'admin' }));
    expect(metrics.date).toBe(today);
    expect(metrics.computedAt).toEqual({ seconds: expect.any(Number), nanoseconds: expect.any(Number) });
    expect(fakeDb.read<any>(`orgs/${ORG}/metrics/${today}`)).toBeDefined();
  });
});
