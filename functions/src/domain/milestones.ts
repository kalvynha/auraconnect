/**
 * Hospice regulatory milestones. Pure module: no Firebase imports.
 *
 * Rules (docs/DATA_MODEL.md, "Milestone rules"). The admission date is the
 * election date and counts as **day 1** of the stay.
 *
 *  - NOE: "within 5 calendar days after the election date" → due = admission + 5.
 *  - Benefit periods: periods 1 and 2 are 90 days, 3+ are 60 days. The first
 *    computed period is `startingBenefitPeriod` (a transfer can start in 3+)
 *    and uses that period's length. Period end = start + length − 1 (inclusive);
 *    the next period starts the day after.
 *  - F2F: required for period ≥ 3. Window = the 30 days before the period
 *    starts: windowStart = periodStart − 30, dueBy = periodStart − 1.
 *  - HOPE admission assessment: "by day 5" with admission = day 1 → admission + 4.
 *  - HOPE Update Visit 1: days 6–15 → admission + 5 … admission + 14.
 *  - HOPE Update Visit 2: days 16–30 → admission + 15 … admission + 29.
 *
 * NOTE: NOE uses "within 5 days AFTER election" (admission + 5) whereas HOPE
 * uses "day 5 of the stay" (admission + 4). This asymmetry is intentional and
 * must be checked by compliance staff.
 */
import type { BenefitPeriod, ISODate, MilestoneKind, Milestones } from '../shared/types';
import { addDays, compareISO, isValidISODate } from './dates';

export const DEFAULT_PERIOD_COUNT = 6;
/** Deadlines more than this many days overdue are no longer reminded. */
export const MAX_OVERDUE_DAYS = 30;

export function benefitPeriodLength(periodNumber: number): 90 | 60 {
  return periodNumber <= 2 ? 90 : 60;
}

export function computeBenefitPeriods(
  admissionDate: ISODate,
  startingBenefitPeriod = 1,
  count = DEFAULT_PERIOD_COUNT,
): BenefitPeriod[] {
  const first = Math.max(1, Math.floor(startingBenefitPeriod));
  const periods: BenefitPeriod[] = [];
  let start = admissionDate;
  for (let i = 0; i < Math.max(1, count); i++) {
    const number = first + i;
    const lengthDays = benefitPeriodLength(number);
    const end = addDays(start, lengthDays - 1);
    const f2fRequired = number >= 3;
    periods.push({
      number,
      start,
      end,
      lengthDays,
      f2fRequired,
      f2fWindowStart: f2fRequired ? addDays(start, -30) : null,
      f2fDueBy: f2fRequired ? addDays(start, -1) : null,
    });
    start = addDays(end, 1);
  }
  return periods;
}

export function computeMilestones(
  admissionDate: ISODate,
  startingBenefitPeriod = 1,
  computedAt: ISODate = admissionDate,
  periodCount = DEFAULT_PERIOD_COUNT,
): Milestones {
  if (!isValidISODate(admissionDate)) throw new RangeError('admissionDate must be YYYY-MM-DD');
  return {
    noeDueDate: addDays(admissionDate, 5),
    benefitPeriods: computeBenefitPeriods(admissionDate, startingBenefitPeriod, periodCount),
    hopeAdmissionDue: addDays(admissionDate, 4),
    hopeHuv1Window: { start: addDays(admissionDate, 5), end: addDays(admissionDate, 14) },
    hopeHuv2Window: { start: addDays(admissionDate, 15), end: addDays(admissionDate, 29) },
    computedAt,
  };
}

export interface UpcomingDeadline {
  kind: MilestoneKind;
  /** Reminder key stored in `patient.remindedMilestones`, e.g. `noe:2026-10-01`. */
  key: string;
  dueDate: ISODate;
  overdue: boolean;
}

export function milestoneKey(kind: MilestoneKind, dueDate: ISODate): string {
  return `${kind}:${dueDate}`;
}

export const MILESTONE_LABELS: Record<MilestoneKind, string> = {
  noe: 'NOE',
  recert: 'Recertification',
  f2f: 'Face-to-face',
  hope_admission: 'HOPE admission assessment',
  hope_huv1: 'HOPE Update Visit 1',
  hope_huv2: 'HOPE Update Visit 2',
};

/**
 * Deadlines that should be reminded on `today`: NOE, the next recert (period
 * end), the next F2F due date, HOPE admission, HUV1 window end, HUV2 window end.
 *
 * "Next" for recert/F2F means the earliest one that is not more than
 * {@link MAX_OVERDUE_DAYS} overdue, so a just-missed recert is still reported.
 * A deadline is returned only when `dueDate ≤ today + leadDays` and
 * `dueDate ≥ today − MAX_OVERDUE_DAYS`. Sorted by due date.
 */
export function upcomingDeadlines(milestones: Milestones, today: ISODate, leadDays: number): UpcomingDeadline[] {
  const horizon = addDays(today, Math.max(0, Math.floor(leadDays)));
  const oldest = addDays(today, -MAX_OVERDUE_DAYS);
  const notTooOld = (d: ISODate) => compareISO(d, oldest) >= 0;

  const candidates: Array<{ kind: MilestoneKind; dueDate: ISODate }> = [
    { kind: 'noe', dueDate: milestones.noeDueDate },
    { kind: 'hope_admission', dueDate: milestones.hopeAdmissionDue },
    { kind: 'hope_huv1', dueDate: milestones.hopeHuv1Window.end },
    { kind: 'hope_huv2', dueDate: milestones.hopeHuv2Window.end },
  ];
  const periods = [...milestones.benefitPeriods].sort((a, b) => compareISO(a.start, b.start));
  const recert = periods.find((p) => notTooOld(p.end));
  if (recert) candidates.push({ kind: 'recert', dueDate: recert.end });
  const f2f = periods.find((p) => p.f2fRequired && p.f2fDueBy && notTooOld(p.f2fDueBy));
  if (f2f?.f2fDueBy) candidates.push({ kind: 'f2f', dueDate: f2f.f2fDueBy });

  return candidates
    .filter((c) => notTooOld(c.dueDate) && compareISO(c.dueDate, horizon) <= 0)
    .map((c) => ({
      kind: c.kind,
      dueDate: c.dueDate,
      key: milestoneKey(c.kind, c.dueDate),
      overdue: compareISO(c.dueDate, today) < 0,
    }))
    .sort((a, b) => compareISO(a.dueDate, b.dueDate));
}
