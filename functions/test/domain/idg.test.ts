import { describe, expect, it } from 'vitest';
import { effectiveNextIdgDue, nextIdgDue, selectIdgAgenda } from '../../src/domain/idg';

const p = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'admitted' as const, admissionDate: '2026-09-01', lastIdgReviewDate: null, nextIdgDueDate: null, ...over,
});

describe('selectIdgAgenda', () => {
  it('includes admitted patients due on or before meeting date + 7 days, ordered by due date', () => {
    const patients = [
      p('later', { nextIdgDueDate: '2026-10-09' }), // meeting 10-01 + 7 = 10-08 → excluded
      p('edge', { nextIdgDueDate: '2026-10-08' }),
      p('overdue', { nextIdgDueDate: '2026-09-20' }),
      p('discharged', { status: 'discharged', nextIdgDueDate: '2026-09-20' }),
      p('referral', { status: 'referral', nextIdgDueDate: '2026-09-20' }),
    ];
    expect(selectIdgAgenda(patients as any, '2026-10-01', 15)).toEqual(['overdue', 'edge']);
  });

  it('derives the due date for pre-v2 patients from the last review or admission', () => {
    const patients = [
      p('byAdmission', { admissionDate: '2026-09-20' }), // due 10-05
      p('byReview', { admissionDate: '2026-01-01', lastIdgReviewDate: '2026-09-30' }), // due 10-15
      p('noDates', { admissionDate: null }),
    ];
    expect(selectIdgAgenda(patients as any, '2026-10-01', 15)).toEqual(['byAdmission']);
    expect(effectiveNextIdgDue(patients[1] as any, 15)).toBe('2026-10-15');
    expect(effectiveNextIdgDue(patients[2] as any, 15)).toBeNull();
    expect(nextIdgDue('2026-09-26', 14)).toBe('2026-10-10');
  });
});
