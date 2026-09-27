import type { MilestoneKind, Milestones, Patient } from '@shared/types';
import { daysBetween, todayISO } from './format';

export interface Deadline {
  kind: MilestoneKind;
  label: string;
  due: string;
  /** Start of the window, when the milestone is a window (HOPE HUVs, F2F). */
  windowStart?: string;
}

export const MILESTONE_LABELS: Record<MilestoneKind, string> = {
  noe: 'Notice of Election (NOE)',
  recert: 'Recertification',
  f2f: 'Face-to-face encounter',
  hope_admission: 'HOPE admission assessment',
  hope_huv1: 'HOPE Update Visit 1',
  hope_huv2: 'HOPE Update Visit 2',
};

/** Flatten a patient's milestones into dated deadlines. */
export function deadlinesOf(m: Milestones | null | undefined): Deadline[] {
  if (!m) return [];
  const out: Deadline[] = [
    { kind: 'noe', label: MILESTONE_LABELS.noe, due: m.noeDueDate },
    { kind: 'hope_admission', label: MILESTONE_LABELS.hope_admission, due: m.hopeAdmissionDue },
    { kind: 'hope_huv1', label: MILESTONE_LABELS.hope_huv1, due: m.hopeHuv1Window.end, windowStart: m.hopeHuv1Window.start },
    { kind: 'hope_huv2', label: MILESTONE_LABELS.hope_huv2, due: m.hopeHuv2Window.end, windowStart: m.hopeHuv2Window.start },
  ];
  for (const bp of m.benefitPeriods ?? []) {
    out.push({ kind: 'recert', label: `Recertification (end of period ${bp.number})`, due: bp.end });
    if (bp.f2fRequired && bp.f2fDueBy) {
      out.push({
        kind: 'f2f',
        label: `F2F for period ${bp.number}`,
        due: bp.f2fDueBy,
        windowStart: bp.f2fWindowStart ?? undefined,
      });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

/** Deadlines due between `fromDays` and `toDays` days from today (inclusive; negative = past). */
export function deadlinesWithin(m: Milestones | null | undefined, fromDays: number, toDays: number): Deadline[] {
  const today = todayISO();
  return deadlinesOf(m).filter((d) => {
    const diff = daysBetween(today, d.due);
    return diff >= fromDays && diff <= toDays;
  });
}

/** The benefit period containing today, if any. */
export function currentBenefitPeriodNumber(m: Milestones | null | undefined): number | null {
  if (!m) return null;
  const today = todayISO();
  return m.benefitPeriods.find((bp) => bp.start <= today && today <= bp.end)?.number ?? null;
}

/** Milestone key used by `milestoneCompletions` / `remindedMilestones`: `{kind}:{dueDate}`. */
export function milestoneKey(d: Pick<Deadline, 'kind' | 'due'>): string {
  return `${d.kind}:${d.due}`;
}

export interface OpenDeadline extends Deadline {
  /** Days from `today` to the due date (negative = overdue). */
  diff: number;
  overdue: boolean;
}

/**
 * Every deadline of a patient that is not yet filed/completed (`milestoneCompletions`),
 * with no look-back cap: an overdue milestone stays overdue until it is completed.
 * Callers pick their own look-ahead window with `diff`.
 */
export function openDeadlines(
  patient: Pick<Patient, 'milestones' | 'milestoneCompletions'>,
  today: string = todayISO(),
): OpenDeadline[] {
  const done = patient.milestoneCompletions ?? {};
  return deadlinesOf(patient.milestones)
    .filter((d) => !done[milestoneKey(d)])
    .map((d) => {
      const diff = daysBetween(today, d.due);
      return { ...d, diff, overdue: diff < 0 };
    });
}

/** Open deadlines split into all overdue ones and those due within `aheadDays` (0 = today). */
export function deadlineCounts(
  patient: Pick<Patient, 'milestones' | 'milestoneCompletions'>,
  today: string,
  aheadDays: number,
): { overdue: number; soon: number } {
  let overdue = 0;
  let soon = 0;
  for (const d of openDeadlines(patient, today)) {
    if (d.overdue) overdue++;
    else if (d.diff <= aheadDays) soon++;
  }
  return { overdue, soon };
}
