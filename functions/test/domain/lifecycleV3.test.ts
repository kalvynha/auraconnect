import { describe, expect, it } from 'vitest';
import {
  benefitPeriodStartError,
  completionDate,
  computeBenefitPeriods,
  computeMilestones,
  DEADLINE_LEAD_DAYS_DEFAULTS,
  f2fInWindow,
  leadDaysResolver,
  newAdmissionF2FWindow,
  recertCertificationDateError,
  recomputeBenefitPeriods,
  reminderKey,
  standardF2FWindow,
  unhandledDeadlines,
  upcomingDeadlines,
} from '../../src/domain/milestones';
import { zonedLocalToEpochMs } from '../../src/lifecycle/notifyCareTeam';

describe('S4 F2F windows', () => {
  it('standard window: the 30 days before the period starts', () => {
    expect(standardF2FWindow('2026-06-30')).toEqual({ windowStart: '2026-05-31', dueBy: '2026-06-29' });
  });

  it('new admission in period ≥ 3: admission − 30 through admission + 2', () => {
    expect(newAdmissionF2FWindow('2026-05-10')).toEqual({ windowStart: '2026-04-10', dueBy: '2026-05-12' });
    expect(newAdmissionF2FWindow('2028-02-28')).toEqual({ windowStart: '2028-01-29', dueBy: '2028-03-01' }); // leap year
  });

  it('a new admission in period 1 or 2 has no first-period F2F; later periods use the standard window', () => {
    const p = computeBenefitPeriods('2026-01-01', 2, 3);
    expect(p[0]).toMatchObject({ number: 2, f2fRequired: false, f2fDueBy: null });
    expect(p[1]).toMatchObject({ number: 3, start: '2026-04-01', f2fRequired: true, f2fWindowStart: '2026-03-02', f2fDueBy: '2026-03-31' });
  });
});

describe('S4 transfers (benefitPeriodStart)', () => {
  it('continues the current period from its original start', () => {
    const p = computeBenefitPeriods('2026-05-10', 3, 3, { benefitPeriodStart: '2026-04-20' });
    expect(p[0]).toMatchObject({ number: 3, start: '2026-04-20', end: '2026-06-18', lengthDays: 60 });
    // The continued period's F2F was the prior hospice's: not tracked here.
    expect(p[0]).toMatchObject({ f2fRequired: false, f2fWindowStart: null, f2fDueBy: null });
    expect(p[1]).toMatchObject({ number: 4, start: '2026-06-19', f2fRequired: true, f2fDueBy: '2026-06-18', f2fWindowStart: '2026-05-20' });
  });

  it('milestones: NOE and HOPE stay tied to admission; recert to the period end', () => {
    const m = computeMilestones('2026-05-10', 1, '2026-05-10', 2, { benefitPeriodStart: '2026-03-01' });
    expect(m.noeDueDate).toBe('2026-05-15');
    expect(m.hopeAdmissionDue).toBe('2026-05-14');
    expect(m.benefitPeriods[0]).toMatchObject({ number: 1, start: '2026-03-01', end: '2026-05-29' });
    expect(upcomingDeadlines(m, '2026-05-20', 15).find((d) => d.kind === 'recert')).toMatchObject({ dueDate: '2026-05-29' });
  });

  it('benefitPeriodStart equal to admission is a new period (not a transfer)', () => {
    const p = computeBenefitPeriods('2026-05-10', 3, 1, { benefitPeriodStart: '2026-05-10' });
    expect(p[0]).toMatchObject({ start: '2026-05-10', f2fRequired: true, f2fDueBy: '2026-05-12' });
  });

  it('validates the period start against the admission', () => {
    expect(benefitPeriodStartError('2026-05-10', 3, null)).toBeNull();
    expect(benefitPeriodStartError('2026-05-10', 3, '2026-03-12')).toBeNull(); // day 60 of a 60-day period
    expect(benefitPeriodStartError('2026-05-10', 3, '2026-03-11')).toMatch(/outside benefit period 3/);
    expect(benefitPeriodStartError('2026-05-10', 1, '2026-02-10')).toBeNull(); // 90-day period
    expect(benefitPeriodStartError('2026-05-10', 1, '2026-05-11')).toMatch(/after the admission/);
    expect(() => computeBenefitPeriods('2026-05-10', 3, 1, { benefitPeriodStart: '2026-01-01' })).toThrow(RangeError);
  });

  it('recompute keeps the transfer start', () => {
    const p = recomputeBenefitPeriods({ admissionDate: '2026-05-10', startingBenefitPeriod: 3, benefitPeriodStart: '2026-04-20' }, 4);
    expect(p.map((x) => x.start)).toEqual(['2026-04-20', '2026-06-19', '2026-08-18', '2026-10-17']);
  });
});

describe('S4 recertification validation', () => {
  const period = { number: 3, start: '2026-06-30', f2fRequired: true, f2fWindowStart: '2026-05-31', f2fDueBy: '2026-06-29' };

  it('certification date must be within period start − 15 … period start', () => {
    expect(recertCertificationDateError(period, '2026-06-15')).toBeNull();
    expect(recertCertificationDateError(period, '2026-06-30')).toBeNull();
    expect(recertCertificationDateError(period, '2026-06-14')).toMatch(/between 2026-06-15 and 2026-06-30/);
    expect(recertCertificationDateError(period, '2026-07-01')).not.toBeNull();
  });

  it('f2fInWindow', () => {
    expect(f2fInWindow(period, '2026-05-31')).toBe(true);
    expect(f2fInWindow(period, '2026-06-29')).toBe(true);
    expect(f2fInWindow(period, '2026-05-30')).toBe(false);
    expect(f2fInWindow(period, '2026-06-30')).toBe(false);
    expect(f2fInWindow({ f2fRequired: false, f2fWindowStart: null, f2fDueBy: null }, '2026-06-01')).toBeNull();
  });
});

describe('S1 / V1 reminders', () => {
  const m = computeMilestones('2026-01-01', 1);

  it('lead days per kind: org setting, then defaults, then deadlineLeadDays', () => {
    expect(DEADLINE_LEAD_DAYS_DEFAULTS).toMatchObject({ noe: 3, recert: 15, f2f: 30, hope_admission: 2, hope_huv1: 2, hope_huv2: 2 });
    const lead = leadDaysResolver({ deadlineLeadDays: 7, deadlineLeadDaysByKind: { recert: 20 } });
    expect(lead('recert')).toBe(20);
    expect(lead('noe')).toBe(3);
    expect(lead('f2f')).toBe(30);
    expect(leadDaysResolver({ deadlineLeadDays: 7 })('hope_huv1')).toBe(2);
    expect(leadDaysResolver({ deadlineLeadDays: 7, deadlineLeadDaysByKind: { noe: 0 } })('noe')).toBe(0);
    // A kind without a default falls back to deadlineLeadDays.
    expect(leadDaysResolver({ deadlineLeadDays: 7 })('aide_supervision' as never)).toBe(7);
  });

  it('upcomingDeadlines applies per-kind lead days', () => {
    const lead = leadDaysResolver({ deadlineLeadDays: 3 });
    // 2026-03-17: recert (03-31) is 14 days out → inside its 15-day lead; F2F for period 3 (06-29) is 104 days out.
    const d = upcomingDeadlines(m, '2026-03-17', lead).filter((x) => !x.overdue);
    expect(d.map((x) => x.key)).toEqual(['recert:2026-03-31']);
    // 2026-05-31: F2F (06-29) is 29 days out → inside its 30-day lead; the recert on the same day is not (15).
    const f = upcomingDeadlines(m, '2026-05-31', lead).filter((x) => !x.overdue);
    expect(f.map((x) => x.key)).toEqual(['f2f:2026-06-29']);
  });

  it('overdue reminders use a separate key, so each deadline alerts at most twice', () => {
    const upcoming = upcomingDeadlines(m, '2026-01-04', 3).find((x) => x.kind === 'noe')!;
    expect(reminderKey(upcoming)).toBe('noe:2026-01-06');
    const overdue = upcomingDeadlines(m, '2026-01-07', 3).find((x) => x.kind === 'noe')!;
    expect(reminderKey(overdue)).toBe('noe:2026-01-06#overdue');
    // Upcoming already reminded → the overdue reminder is still due.
    expect(unhandledDeadlines([overdue], ['noe:2026-01-06'], {})).toHaveLength(1);
    // Overdue reminded → never again, however long it stays overdue.
    expect(unhandledDeadlines([overdue], ['noe:2026-01-06', 'noe:2026-01-06#overdue'], {})).toHaveLength(0);
    // Completed → nothing.
    expect(unhandledDeadlines([overdue], [], { 'noe:2026-01-06': {} })).toHaveLength(0);
  });

  it('completionDate prefers effectiveDate (S5)', () => {
    const local = () => '2026-01-09';
    expect(completionDate({ effectiveDate: '2026-01-05', completedAt: {} }, local)).toBe('2026-01-05');
    expect(completionDate({ completedAt: {} }, local)).toBe('2026-01-09');
    expect(completionDate(null, local)).toBeNull();
  });
});

describe('zonedLocalToEpochMs', () => {
  it('converts local wall time in a zone to an instant (DST aware)', () => {
    expect(new Date(zonedLocalToEpochMs('2026-01-15', '03:40', 'America/New_York')).toISOString()).toBe('2026-01-15T08:40:00.000Z');
    expect(new Date(zonedLocalToEpochMs('2026-07-15', '03:40', 'America/New_York')).toISOString()).toBe('2026-07-15T07:40:00.000Z');
    expect(new Date(zonedLocalToEpochMs('2026-07-15', '23:05', 'UTC')).toISOString()).toBe('2026-07-15T23:05:00.000Z');
    expect(new Date(zonedLocalToEpochMs('2026-07-15', '23:05', 'Not/AZone')).toISOString()).toBe('2026-07-15T23:05:00.000Z');
  });
});
