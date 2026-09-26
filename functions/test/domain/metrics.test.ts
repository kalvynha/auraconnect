import { describe, expect, it } from 'vitest';
import { computeMilestones } from '../../src/domain/milestones';
import { computeDailyMetricsValues, countVisits, median, zonedDayBounds, type MetricsInput } from '../../src/domain/metrics';

const DATE = '2026-09-25';
const H = 3_600_000;
const t = (iso: string) => Date.parse(iso);

function base(over: Partial<MetricsInput> = {}): MetricsInput {
  return {
    date: DATE,
    timeZone: 'UTC',
    patients: [],
    referralCount: 0,
    alerts: [],
    visits: { scheduled: 0, completed: 0, missed: 0, cancelled: 0 },
    triageCalls: [],
    volunteerLogs: [],
    activeVolunteerAssignments: 0,
    bereavementPlans: [],
    ...over,
  };
}

describe('median', () => {
  it('handles empty, odd and even inputs', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('computeDailyMetricsValues', () => {
  it('computes census and level of care', () => {
    const m = computeDailyMetricsValues(
      base({
        referralCount: 4,
        patients: [
          { status: 'admitted', levelOfCare: 'routine' },
          { status: 'admitted', levelOfCare: 'gip' },
          { status: 'admitted', levelOfCare: null },
          { status: 'discharged', dischargeDate: DATE },
          { status: 'discharged', dischargeDate: '2026-09-20' },
          { status: 'deceased', deathDate: DATE },
        ],
      }),
    );
    expect(m.census).toEqual({ admitted: 3, referral: 4, dischargedToday: 1, deathsToday: 1 });
    expect(m.levelOfCare).toEqual({ routine: 2, continuous: 0, respite: 0, gip: 1 });
  });

  it('computes alert counts and median ack minutes', () => {
    const c = t('2026-09-25T10:00:00Z');
    const m = computeDailyMetricsValues(
      base({
        alerts: [
          { createdAtMs: c, ackedAtMs: c + 4 * 60_000, exhausted: false },
          { createdAtMs: c, ackedAtMs: c + 10 * 60_000, exhausted: false },
          { createdAtMs: c, ackedAtMs: null, exhausted: true },
        ],
      }),
    );
    expect(m.alerts).toEqual({ created: 3, acked: 2, medianAckMinutes: 7, exhausted: 1 });
    expect(computeDailyMetricsValues(base()).alerts.medianAckMinutes).toBeNull();
  });

  it('counts due, overdue and completed deadlines excluding completed keys', () => {
    // Admitted 2026-09-20: NOE due 09-25, HOPE admission 09-24 (overdue), HUV1 ends 10-04 (outside horizon).
    const milestones = computeMilestones('2026-09-20');
    const m = computeDailyMetricsValues(
      base({
        patients: [
          {
            status: 'admitted',
            milestones,
            completions: {
              'noe:2026-09-25': t('2026-09-24T12:00:00Z'), // on time, removes NOE from due
              'hope_admission:2026-09-24': t('2026-09-25T09:00:00Z'), // late, removes from overdue
              'noe:2026-07-01': t('2026-08-01T00:00:00Z'), // outside the 30-day window
            },
          },
          { status: 'admitted', milestones: computeMilestones('2026-09-01') }, // HOPE/NOE long overdue, HUV2 due 09-30
        ],
      }),
    );
    expect(m.deadlines.completedOnTime30d).toBe(1);
    expect(m.deadlines.completedLate30d).toBe(1);
    // patient 1: HUV1 ends 10-04, beyond the 7-day horizon (10-02); patient 2: HUV2 (09-30) due,
    // and its NOE 09-06, HOPE 09-05, HUV1 09-15 are overdue
    expect(m.deadlines.dueNext7Days).toBe(1);
    expect(m.deadlines.overdue).toBe(3);
  });

  it('judges on-time in the org time zone', () => {
    // 2026-09-25T02:00Z is still 09-24 in New York → on time for a 09-24 deadline.
    const m = computeDailyMetricsValues(
      base({ timeZone: 'America/New_York', patients: [{ status: 'discharged', completions: { 'hope_admission:2026-09-24': t('2026-09-25T02:00:00Z') } }] }),
    );
    expect(m.deadlines).toMatchObject({ completedOnTime30d: 1, completedLate30d: 0 });
  });

  it('computes visits, triage, volunteers and bereavement', () => {
    const r = t('2026-09-25T03:00:00Z');
    const m = computeDailyMetricsValues(
      base({
        visits: countVisits([{ status: 'completed' }, { status: 'completed' }, { status: 'missed' }, { status: 'scheduled' }, { status: 'bogus' }]),
        triageCalls: [
          { urgency: 'emergent', receivedAtMs: r, resolvedAtMs: r + 30 * 60_000 },
          { urgency: 'routine', receivedAtMs: r, resolvedAtMs: r + 90 * 60_000 },
          { urgency: 'urgent', receivedAtMs: r, resolvedAtMs: null },
        ],
        volunteerLogs: [
          { date: DATE, minutes: 60 },
          { date: '2026-08-27', minutes: 30 }, // day 30 of the window (inclusive)
          { date: '2026-08-26', minutes: 999 }, // outside
          { date: '2026-09-26', minutes: 999 }, // future
        ],
        activeVolunteerAssignments: 3,
        bereavementPlans: [
          {
            status: 'active',
            contacts: [
              { dueDate: '2026-09-20', status: 'pending' },
              { dueDate: '2026-09-20', status: 'done' },
              { dueDate: DATE, status: 'pending' },
              { dueDate: '2026-10-02', status: 'pending' },
              { dueDate: '2026-10-03', status: 'pending' },
            ],
          },
          { status: 'closed', contacts: [{ dueDate: '2026-09-01', status: 'pending' }] },
        ],
      }),
    );
    expect(m.visits).toEqual({ scheduled: 1, completed: 2, missed: 1, cancelled: 0 });
    expect(m.triage).toEqual({ calls: 3, emergent: 1, medianResolveMinutes: 60 });
    expect(m.volunteers).toEqual({ minutesLast30d: 90, activeAssignments: 3 });
    expect(m.bereavement).toEqual({ activePlans: 1, contactsDueNext7Days: 2, contactsOverdue: 1 });
    expect(m.date).toBe(DATE);
  });
});

describe('zonedDayBounds', () => {
  it('returns UTC midnight bounds for UTC', () => {
    expect(zonedDayBounds(DATE, 'UTC')).toEqual({ startMs: t('2026-09-25T00:00:00Z'), endMs: t('2026-09-26T00:00:00Z') });
  });
  it('handles offsets and DST transitions', () => {
    expect(zonedDayBounds(DATE, 'America/New_York')).toEqual({ startMs: t('2026-09-25T04:00:00Z'), endMs: t('2026-09-26T04:00:00Z') });
    const fallBack = zonedDayBounds('2026-11-01', 'America/New_York');
    expect(fallBack.startMs).toBe(t('2026-11-01T04:00:00Z'));
    expect((fallBack.endMs - fallBack.startMs) / H).toBe(25);
    const kolkata = zonedDayBounds(DATE, 'Asia/Kolkata');
    expect(kolkata.startMs).toBe(t('2026-09-24T18:30:00Z'));
  });
});
