import { describe, expect, it } from 'vitest';
import {
  chooseDays,
  planVisitId,
  planWeek,
  visitsInWeek,
  weekIndex,
  zonedTimeToUtcMs,
  type ExistingVisitSpan,
  type PlanPatient,
} from '../../src/domain/visitPlan';
import type { VisitFrequency } from '../../src/shared/types';

const WEEK = '2026-10-05'; // a Monday
const BEFORE = Date.parse('2026-10-01T00:00:00Z');

function freq(over: Partial<VisitFrequency> = {}): VisitFrequency {
  return { discipline: 'RN', perWeek: 2, notes: null, ...over };
}

function patient(over: Partial<PlanPatient> = {}): PlanPatient {
  return { id: 'p1', name: 'Doe, Jane', frequencies: [freq()], careTeam: [{ uid: 'rn1', discipline: 'RN' }, { uid: 'sw1', discipline: 'SW' }], ...over };
}

function plan(patients: PlanPatient[], existing: ExistingVisitSpan[] = [], over: Partial<Parameters<typeof planWeek>[0]> = {}) {
  return planWeek({ weekStart: WEEK, timeZone: 'UTC', nowMs: BEFORE, patients, existing, activeUids: new Set(['rn1', 'sw1', 'rn2']), ...over });
}

describe('week index and fractional frequencies', () => {
  it('weekIndex is Monday-aligned and continuous across a 53-week ISO year', () => {
    expect(weekIndex('2026-10-05')).toBe(weekIndex('2026-10-11'));
    expect(weekIndex('2026-10-12')).toBe(weekIndex('2026-10-05') + 1);
    // 2026 has ISO week 53 (Dec 28 – Jan 3); parity still alternates into 2027.
    expect(weekIndex('2027-01-04') - weekIndex('2026-12-28')).toBe(1);
  });

  it('0.5/week alternates by week parity; 1.5 alternates 1 and 2; 0.25 is every fourth week', () => {
    const w = weekIndex(WEEK);
    const halves = [0, 1, 2, 3].map((i) => visitsInWeek(0.5, w + i));
    expect(halves.reduce((a, b) => a + b)).toBe(2);
    expect(halves[0]).not.toBe(halves[1]);
    expect(visitsInWeek(0.5, 1)).toBe(1);
    expect(visitsInWeek(0.5, 2)).toBe(0);
    expect([0, 1, 2, 3].map((i) => visitsInWeek(1.5, i)).sort()).toEqual([1, 1, 2, 2]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => visitsInWeek(0.25, i)).reduce((a, b) => a + b)).toBe(2);
    expect(visitsInWeek(3, 99)).toBe(3);
    expect(visitsInWeek(0, 1)).toBe(0);
  });

  it('chooseDays spreads over weekdays unless preferred days are given', () => {
    expect(chooseDays(1)).toEqual([3]);
    expect(chooseDays(2)).toEqual([2, 4]);
    expect(chooseDays(3)).toEqual([1, 3, 5]);
    expect(chooseDays(5)).toEqual([1, 2, 3, 4, 5]);
    expect(chooseDays(7)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(chooseDays(2, [5, 1, 5, 9])).toEqual([5, 1]);
  });

  it('zonedTimeToUtcMs handles DST in America/New_York', () => {
    expect(new Date(zonedTimeToUtcMs('2026-07-01', '09:00', 'America/New_York')).toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(new Date(zonedTimeToUtcMs('2026-12-01', '09:00', 'America/New_York')).toISOString()).toBe('2026-12-01T14:00:00.000Z');
    // Day after the fall-back transition (2026-11-01).
    expect(new Date(zonedTimeToUtcMs('2026-11-02', '09:30', 'America/New_York')).toISOString()).toBe('2026-11-02T14:30:00.000Z');
  });
});

describe('planWeek', () => {
  it('proposes deterministic visits assigned to the care-team discipline', () => {
    const res = plan([patient()]);
    expect(res.visits.map((v) => [v.id, v.start, v.assignedUid])).toEqual([
      [planVisitId('p1', 'RN', WEEK, 1), '2026-10-06T09:00:00.000Z', 'rn1'],
      [planVisitId('p1', 'RN', WEEK, 2), '2026-10-08T09:00:00.000Z', 'rn1'],
    ]);
    expect(res.visits[0]!.id).toBe('plan_p1_RN_2026-10-05_1');
    expect(res.conflicts).toEqual([]);
  });

  it('uses preferred days, start time, duration and the planned assignee', () => {
    const res = plan([patient({ frequencies: [freq({ perWeek: 1, preferredDays: [5], preferredStart: '13:30', durationMinutes: 45, assignedUid: 'rn2' })] })]);
    expect(res.visits).toEqual([
      expect.objectContaining({ start: '2026-10-09T13:30:00.000Z', end: '2026-10-09T14:15:00.000Z', assignedUid: 'rn2', discipline: 'RN' }),
    ]);
  });

  it('falls back to the care team (and reports it) when the planned assignee is inactive; unassigned otherwise', () => {
    const res = plan([patient({ frequencies: [freq({ perWeek: 1, assignedUid: 'gone' }), freq({ discipline: 'Chaplain', perWeek: 1 })] })]);
    expect(res.visits.find((v) => v.discipline === 'RN')!.assignedUid).toBe('rn1');
    expect(res.visits.find((v) => v.discipline === 'Chaplain')!.assignedUid).toBeNull();
    expect(res.conflicts.map((c) => c.kind).sort()).toEqual(['inactive_assignee', 'unassigned']);
  });

  it('subtracts existing visits and is idempotent once the plan exists', () => {
    const first = plan([patient({ frequencies: [freq({ perWeek: 3 })] })]);
    expect(first.visits).toHaveLength(3);
    const existing: ExistingVisitSpan[] = first.visits.map((v) => ({
      id: v.id, patientId: v.patientId, discipline: v.discipline, status: 'scheduled', assignedUid: v.assignedUid, startMs: Date.parse(v.start), endMs: Date.parse(v.end),
    }));
    const again = plan([patient({ frequencies: [freq({ perWeek: 3 })] })], existing);
    expect(again.visits).toEqual([]);
    expect(again.existing).toBe(3);

    // A manual visit counts; the plan fills the remaining slot on a free day.
    const manual: ExistingVisitSpan = { id: 'manual1', patientId: 'p1', discipline: 'RN', status: 'completed', assignedUid: 'rn1', startMs: Date.parse('2026-10-05T15:00:00Z'), endMs: Date.parse('2026-10-05T16:00:00Z') };
    const partial = plan([patient({ frequencies: [freq({ perWeek: 3 })] })], [manual, existing[1]!]);
    expect(partial.visits).toHaveLength(1);
    expect(partial.visits[0]!.id).toBe(planVisitId('p1', 'RN', WEEK, 3));

    // A cancelled plan visit is not recreated; a cancelled manual visit does not count.
    const cancelledPlan = { ...existing[0]!, status: 'cancelled' };
    const cancelledManual = { ...manual, status: 'cancelled' };
    const res = plan([patient({ frequencies: [freq({ perWeek: 1 })] })], [cancelledPlan, cancelledManual]);
    expect(res.visits).toEqual([]);
  });

  it('reports overlaps with the assignee’s other visits and skips past slots', () => {
    const busy: ExistingVisitSpan = { id: 'other', patientId: 'p9', discipline: 'RN', status: 'scheduled', assignedUid: 'rn1', startMs: Date.parse('2026-10-06T09:30:00Z'), endMs: Date.parse('2026-10-06T10:30:00Z') };
    const res = plan([patient()], [busy]);
    expect(res.visits).toHaveLength(2);
    expect(res.conflicts).toEqual([expect.objectContaining({ kind: 'overlap', visitId: planVisitId('p1', 'RN', WEEK, 1) })]);

    const mid = plan([patient()], [], { nowMs: Date.parse('2026-10-07T00:00:00Z') });
    expect(mid.visits.map((v) => v.start)).toEqual(['2026-10-08T09:00:00.000Z']);
    expect(mid.conflicts).toEqual([expect.objectContaining({ kind: 'past' })]);
  });

  it('stacks extra visits on the same day when there are more visits than days', () => {
    const res = plan([patient({ frequencies: [freq({ perWeek: 2, preferredDays: [1] })] })]);
    expect(res.visits.map((v) => v.start)).toEqual(['2026-10-05T09:00:00.000Z', '2026-10-05T11:00:00.000Z']);
  });
});
