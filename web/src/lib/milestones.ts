import type { MilestoneKind, Milestones } from '@shared/types';
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
