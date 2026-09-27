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
 *    v3 (S4): for a NEW admission whose first period is ≥ 3, the F2F may be done
 *    up to 2 days after admission: windowStart = admission − 30, dueBy = admission + 2.
 *  - v3 (S4) transfers: `benefitPeriodStart` (< admission) is the start of the period
 *    the patient is already in; it continues from that start. The continued period's
 *    F2F belonged to the prior hospice, so it is not tracked (`f2fRequired: false`).
 *  - HOPE admission assessment: "by day 5" with admission = day 1 → admission + 4.
 *  - HOPE Update Visit 1: days 6–15 → admission + 5 … admission + 14.
 *  - HOPE Update Visit 2: days 16–30 → admission + 15 … admission + 29.
 *
 * NOTE: NOE uses "within 5 days AFTER election" (admission + 5) whereas HOPE
 * uses "day 5 of the stay" (admission + 4). This asymmetry is intentional and
 * must be checked by compliance staff.
 */
import { DEADLINE_LEAD_DAYS_DEFAULTS, type BenefitPeriod, type ISODate, type MilestoneKind, type Milestones } from '../shared/types';
import { addDays, compareISO, diffDays, isValidISODate } from './dates';

export const DEFAULT_PERIOD_COUNT = 6;

export function benefitPeriodLength(periodNumber: number): 90 | 60 {
  return periodNumber <= 2 ? 90 : 60;
}

/** Normal F2F window for a period that starts at `periodStart`: the 30 days before it. */
export function standardF2FWindow(periodStart: ISODate): { windowStart: ISODate; dueBy: ISODate } {
  return { windowStart: addDays(periodStart, -30), dueBy: addDays(periodStart, -1) };
}

/**
 * S4: F2F window for a NEW hospice admission in benefit period ≥ 3 (not a transfer).
 * The encounter may occur from 30 days before admission through 2 calendar days after it.
 */
export function newAdmissionF2FWindow(admissionDate: ISODate): { windowStart: ISODate; dueBy: ISODate } {
  return { windowStart: addDays(admissionDate, -30), dueBy: addDays(admissionDate, 2) };
}

export interface BenefitPeriodOptions {
  /**
   * Start of the benefit period the patient is in at admission. Omitted or equal to the
   * admission date → a new period starts at admission. Earlier → a transfer that continues
   * the prior hospice's period from its original start.
   */
  benefitPeriodStart?: ISODate | null;
}

/**
 * Validates `benefitPeriodStart` against the admission: it must not be after admission and the
 * admission must fall inside that period. Returns an error message, or null when valid/absent.
 */
export function benefitPeriodStartError(admissionDate: ISODate, startingBenefitPeriod: number, benefitPeriodStart: ISODate | null | undefined): string | null {
  if (benefitPeriodStart === null || benefitPeriodStart === undefined) return null;
  if (!isValidISODate(benefitPeriodStart)) return 'The benefit period start must be a valid date.';
  const len = benefitPeriodLength(Math.max(1, Math.floor(startingBenefitPeriod)));
  const d = diffDays(benefitPeriodStart, admissionDate);
  if (d < 0) return 'The benefit period start cannot be after the admission date.';
  if (d >= len) return `The admission date is outside benefit period ${startingBenefitPeriod} (${len} days from its start).`;
  return null;
}

export function computeBenefitPeriods(
  admissionDate: ISODate,
  startingBenefitPeriod = 1,
  count = DEFAULT_PERIOD_COUNT,
  opts: BenefitPeriodOptions = {},
): BenefitPeriod[] {
  const first = Math.max(1, Math.floor(startingBenefitPeriod));
  const err = benefitPeriodStartError(admissionDate, first, opts.benefitPeriodStart);
  if (err) throw new RangeError(err);
  const firstStart = opts.benefitPeriodStart ?? admissionDate;
  const transfer = compareISO(firstStart, admissionDate) < 0;
  const periods: BenefitPeriod[] = [];
  let start = firstStart;
  for (let i = 0; i < Math.max(1, count); i++) {
    const number = first + i;
    const lengthDays = benefitPeriodLength(number);
    const end = addDays(start, lengthDays - 1);
    // The continued period of a transfer: its F2F was the prior hospice's (not tracked here).
    const f2fRequired = number >= 3 && !(i === 0 && transfer);
    const win = !f2fRequired ? null : i === 0 ? newAdmissionF2FWindow(admissionDate) : standardF2FWindow(start);
    periods.push({
      number,
      start,
      end,
      lengthDays,
      f2fRequired,
      f2fWindowStart: win?.windowStart ?? null,
      f2fDueBy: win?.dueBy ?? null,
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
  opts: BenefitPeriodOptions = {},
): Milestones {
  if (!isValidISODate(admissionDate)) throw new RangeError('admissionDate must be YYYY-MM-DD');
  return {
    noeDueDate: addDays(admissionDate, 5),
    benefitPeriods: computeBenefitPeriods(admissionDate, startingBenefitPeriod, periodCount, opts),
    hopeAdmissionDue: addDays(admissionDate, 4),
    hopeHuv1Window: { start: addDays(admissionDate, 5), end: addDays(admissionDate, 14) },
    hopeHuv2Window: { start: addDays(admissionDate, 15), end: addDays(admissionDate, 29) },
    computedAt,
  };
}

/**
 * Benefit periods recomputed for an existing patient (e.g. to extend them after a recert),
 * honouring a transfer's `benefitPeriodStart`.
 */
export function recomputeBenefitPeriods(
  patient: { admissionDate: ISODate; startingBenefitPeriod?: number | null; benefitPeriodStart?: ISODate | null },
  count: number,
): BenefitPeriod[] {
  return computeBenefitPeriods(patient.admissionDate, patient.startingBenefitPeriod ?? 1, count, {
    benefitPeriodStart: patient.benefitPeriodStart ?? null,
  });
}

/**
 * S4: the certification of period `period` must be dated from 15 days before the period starts
 * through its start date. Returns an error message, or null when in range.
 */
export function recertCertificationDateError(period: Pick<BenefitPeriod, 'number' | 'start'>, certificationDate: ISODate): string | null {
  const from = addDays(period.start, -15);
  if (compareISO(certificationDate, from) < 0 || compareISO(certificationDate, period.start) > 0) {
    return `The certification date for benefit period ${period.number} must be between ${from} and ${period.start}.`;
  }
  return null;
}

/** True when `f2fDate` is inside the period's F2F window (null when the period needs no F2F). */
export function f2fInWindow(period: Pick<BenefitPeriod, 'f2fRequired' | 'f2fWindowStart' | 'f2fDueBy'>, f2fDate: ISODate): boolean | null {
  if (!period.f2fRequired || !period.f2fWindowStart || !period.f2fDueBy) return null;
  return compareISO(f2fDate, period.f2fWindowStart) >= 0 && compareISO(f2fDate, period.f2fDueBy) <= 0;
}

/** V1: default reminder lead time per milestone kind (days before the due date). */
export { DEADLINE_LEAD_DAYS_DEFAULTS };

export type LeadDays = number | ((kind: MilestoneKind) => number);

/**
 * Lead days per kind for an org: `deadlineLeadDaysByKind[kind]`, else the default for that kind,
 * else `deadlineLeadDays` (kinds without a default), else 3.
 */
export function leadDaysResolver(org: {
  deadlineLeadDays?: number | null;
  deadlineLeadDaysByKind?: Partial<Record<string, number>> | null;
}): (kind: MilestoneKind) => number {
  return (kind) => {
    const v = org.deadlineLeadDaysByKind?.[kind] ?? DEADLINE_LEAD_DAYS_DEFAULTS[kind] ?? org.deadlineLeadDays ?? 3;
    return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 3;
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
 * Deadlines due on or before `today + leadDays(kind)`: NOE, HOPE admission, HUV1/HUV2 window ends,
 * every benefit period's recert (period end) and every required F2F due-by.
 *
 * S1: there is no overdue look-back cap. A missed deadline stays in the list (overdue) until
 * it is completed, so callers drop completed keys (`unhandledDeadlines`, or their own filter).
 * Sorted by due date.
 */
export function upcomingDeadlines(milestones: Milestones, today: ISODate, leadDays: LeadDays): UpcomingDeadline[] {
  const lead = (kind: MilestoneKind) => Math.max(0, Math.floor(typeof leadDays === 'function' ? leadDays(kind) : leadDays));
  const candidates: Array<{ kind: MilestoneKind; dueDate: ISODate }> = [
    { kind: 'noe', dueDate: milestones.noeDueDate },
    { kind: 'hope_admission', dueDate: milestones.hopeAdmissionDue },
    { kind: 'hope_huv1', dueDate: milestones.hopeHuv1Window.end },
    { kind: 'hope_huv2', dueDate: milestones.hopeHuv2Window.end },
  ];
  for (const p of milestones.benefitPeriods ?? []) {
    candidates.push({ kind: 'recert', dueDate: p.end });
    if (p.f2fRequired && p.f2fDueBy) candidates.push({ kind: 'f2f', dueDate: p.f2fDueBy });
  }
  const seen = new Set<string>();
  return candidates
    .filter((c) => compareISO(c.dueDate, addDays(today, lead(c.kind))) <= 0)
    .map((c) => ({
      kind: c.kind,
      dueDate: c.dueDate,
      key: milestoneKey(c.kind, c.dueDate),
      overdue: compareISO(c.dueDate, today) < 0,
    }))
    .filter((d) => (seen.has(d.key) ? false : (seen.add(d.key), true)))
    .sort((a, b) => compareISO(a.dueDate, b.dueDate));
}

/**
 * S1: the `remindedMilestones` entry for a deadline's reminder. An upcoming deadline uses its key;
 * an overdue one uses `{key}#overdue`, so a deadline is alerted at most twice: once as it comes
 * due (normal) and once when it becomes overdue (urgent).
 */
export function reminderKey(d: Pick<UpcomingDeadline, 'key' | 'overdue'>): string {
  return d.overdue ? `${d.key}#overdue` : d.key;
}

const MILESTONE_KINDS: readonly MilestoneKind[] = ['noe', 'recert', 'f2f', 'hope_admission', 'hope_huv1', 'hope_huv2'];

/** Parses `{kind}:{dueDate}`; null when the kind or date is invalid. */
export function parseMilestoneKey(key: string): { kind: MilestoneKind; dueDate: ISODate } | null {
  const idx = key.indexOf(':');
  if (idx < 0) return null;
  const kind = key.slice(0, idx) as MilestoneKind;
  const dueDate = key.slice(idx + 1);
  if (!MILESTONE_KINDS.includes(kind) || !isValidISODate(dueDate)) return null;
  return { kind, dueDate };
}

/**
 * Every milestone key a patient's milestones can produce: NOE, HOPE admission,
 * HUV1/HUV2 window ends, each period's recert (period end) and each required F2F (due-by).
 */
export function allMilestoneKeys(milestones: Milestones): string[] {
  const keys = [
    milestoneKey('noe', milestones.noeDueDate),
    milestoneKey('hope_admission', milestones.hopeAdmissionDue),
    milestoneKey('hope_huv1', milestones.hopeHuv1Window.end),
    milestoneKey('hope_huv2', milestones.hopeHuv2Window.end),
  ];
  for (const p of milestones.benefitPeriods) {
    keys.push(milestoneKey('recert', p.end));
    if (p.f2fRequired && p.f2fDueBy) keys.push(milestoneKey('f2f', p.f2fDueBy));
  }
  return [...new Set(keys)];
}

/**
 * Drops deadlines whose current reminder ({@link reminderKey}) was already raised, and
 * deadlines already completed (`milestoneCompletions`).
 */
export function unhandledDeadlines(
  deadlines: readonly UpcomingDeadline[],
  reminded: readonly string[] | null | undefined,
  completions: Record<string, unknown> | null | undefined,
): UpcomingDeadline[] {
  const r = new Set(reminded ?? []);
  const done = completions ?? {};
  return deadlines.filter((d) => !r.has(reminderKey(d)) && !Object.prototype.hasOwnProperty.call(done, d.key));
}

/**
 * S5: the date a completion counts from: its `effectiveDate` (the actual filing date), or for
 * completions recorded before v3, the org-local date of `completedAt` (`localDateOf`).
 */
export function completionDate(
  c: { effectiveDate?: ISODate | null; completedAt?: unknown } | null | undefined,
  localDateOf: (completedAt: unknown) => ISODate | null,
): ISODate | null {
  if (!c) return null;
  if (c.effectiveDate && isValidISODate(c.effectiveDate)) return c.effectiveDate;
  return c.completedAt ? localDateOf(c.completedAt) : null;
}

/** "On time": the completion's (effective) date is on or before the key's due date. */
export function completedOnTime(key: string, completedLocalDate: ISODate): boolean | null {
  const parsed = parseMilestoneKey(key);
  return parsed ? compareISO(completedLocalDate, parsed.dueDate) <= 0 : null;
}
