import { describe, expect, it } from 'vitest';
import { computeMilestones, upcomingDeadlines } from '../../src/domain/milestones';

describe('computeMilestones', () => {
  const m = computeMilestones('2026-01-01', 1, '2026-01-01');

  it('NOE is admission + 5', () => {
    expect(m.noeDueDate).toBe('2026-01-06');
  });

  it('HOPE windows treat admission as day 1', () => {
    expect(m.hopeAdmissionDue).toBe('2026-01-05'); // day 5
    expect(m.hopeHuv1Window).toEqual({ start: '2026-01-06', end: '2026-01-15' }); // days 6–15
    expect(m.hopeHuv2Window).toEqual({ start: '2026-01-16', end: '2026-01-30' }); // days 16–30
  });

  it('benefit periods are 90/90/60/60… and contiguous', () => {
    const p = m.benefitPeriods;
    expect(p).toHaveLength(6);
    expect(p.map((x) => x.lengthDays)).toEqual([90, 90, 60, 60, 60, 60]);
    expect(p[0]).toMatchObject({ number: 1, start: '2026-01-01', end: '2026-03-31', f2fRequired: false, f2fWindowStart: null, f2fDueBy: null });
    expect(p[1]).toMatchObject({ number: 2, start: '2026-04-01', end: '2026-06-29' });
    expect(p[2]).toMatchObject({
      number: 3,
      start: '2026-06-30',
      end: '2026-08-28',
      f2fRequired: true,
      f2fWindowStart: '2026-05-31',
      f2fDueBy: '2026-06-29',
    });
    for (let i = 1; i < p.length; i++) {
      expect(p[i]!.number).toBe(p[i - 1]!.number + 1);
    }
  });

  it('starting period 3 uses 60 days and requires F2F before admission', () => {
    const t = computeMilestones('2026-05-10', 3);
    expect(t.benefitPeriods[0]).toMatchObject({
      number: 3,
      start: '2026-05-10',
      end: '2026-07-08',
      lengthDays: 60,
      f2fRequired: true,
      f2fWindowStart: '2026-04-10',
      f2fDueBy: '2026-05-09',
    });
    expect(t.benefitPeriods.every((b) => b.lengthDays === 60 && b.f2fRequired)).toBe(true);
    expect(t.benefitPeriods.map((b) => b.number)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('starting period 2 is 90 days then 60', () => {
    const t = computeMilestones('2026-01-01', 2);
    expect(t.benefitPeriods.map((b) => b.lengthDays)).toEqual([90, 60, 60, 60, 60, 60]);
    expect(t.benefitPeriods[0]!.f2fRequired).toBe(false);
    expect(t.benefitPeriods[1]!.f2fRequired).toBe(true);
  });

  it('handles leap years', () => {
    const t = computeMilestones('2028-02-25', 1);
    expect(t.noeDueDate).toBe('2028-03-01');
    expect(t.hopeAdmissionDue).toBe('2028-02-29');
    expect(t.benefitPeriods[0]!.end).toBe('2028-05-24'); // 90 days incl. Feb 29
  });

  it('rejects invalid admission dates', () => {
    expect(() => computeMilestones('2026-02-30')).toThrow();
  });
});

describe('upcomingDeadlines', () => {
  const m = computeMilestones('2026-01-01', 1);

  it('on admission day with 3-day lead: nothing due within 3 days except none', () => {
    expect(upcomingDeadlines(m, '2026-01-01', 3).map((d) => d.kind)).toEqual([]);
  });

  it('reports HOPE admission and NOE as they come within the lead window', () => {
    const d = upcomingDeadlines(m, '2026-01-03', 3);
    expect(d).toEqual([
      { kind: 'hope_admission', key: 'hope_admission:2026-01-05', dueDate: '2026-01-05', overdue: false },
      { kind: 'noe', key: 'noe:2026-01-06', dueDate: '2026-01-06', overdue: false },
    ]);
  });

  it('flags overdue items and drops those more than 30 days overdue', () => {
    const d = upcomingDeadlines(m, '2026-01-07', 0);
    expect(d.find((x) => x.kind === 'noe')).toMatchObject({ overdue: true });
    const later = upcomingDeadlines(m, '2026-02-06', 0);
    expect(later.find((x) => x.kind === 'noe')).toBeUndefined(); // 31 days overdue
    expect(later.find((x) => x.kind === 'hope_huv2')).toMatchObject({ dueDate: '2026-01-30', overdue: true });
  });

  it('reports the next recert (period end) and next F2F', () => {
    const d = upcomingDeadlines(m, '2026-03-29', 3);
    expect(d.find((x) => x.kind === 'recert')).toMatchObject({ dueDate: '2026-03-31', key: 'recert:2026-03-31', overdue: false });
    const f = upcomingDeadlines(m, '2026-06-27', 3);
    expect(f.find((x) => x.kind === 'f2f')).toMatchObject({ dueDate: '2026-06-29' });
    expect(f.find((x) => x.kind === 'recert')).toMatchObject({ dueDate: '2026-06-29' });
  });

  it('keeps reporting a just-missed recert as overdue', () => {
    const d = upcomingDeadlines(m, '2026-04-02', 3);
    expect(d.find((x) => x.kind === 'recert')).toMatchObject({ dueDate: '2026-03-31', overdue: true });
  });

  it('respects lead days', () => {
    expect(upcomingDeadlines(m, '2026-03-20', 3).find((x) => x.kind === 'recert')).toBeUndefined();
    expect(upcomingDeadlines(m, '2026-03-20', 14).find((x) => x.kind === 'recert')).toBeDefined();
  });
});
