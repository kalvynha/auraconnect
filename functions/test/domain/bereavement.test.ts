import { describe, expect, it } from 'vitest';
import { addMonthsClamped, bereavementClosesOn, buildBereavementSchedule } from '../../src/domain/bereavement';

describe('addMonthsClamped', () => {
  it('clamps to the end of the month', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29'); // leap year
    expect(addMonthsClamped('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonthsClamped('2026-08-31', 13)).toBe('2027-09-30');
    expect(addMonthsClamped('2028-02-29', 12)).toBe('2029-02-28');
  });

  it('rolls over years and keeps ordinary days', () => {
    expect(addMonthsClamped('2026-11-15', 2)).toBe('2027-01-15');
    expect(addMonthsClamped('2026-05-10', 0)).toBe('2026-05-10');
    expect(addMonthsClamped('2026-01-15', -1)).toBe('2025-12-15');
  });
});

describe('buildBereavementSchedule', () => {
  it('builds the 11 default contacts (incl. the month-1 risk reassessment) over 13 months', () => {
    const s = buildBereavementSchedule('2026-01-31');
    expect(s.map((c) => [c.id, c.type, c.dueDate])).toEqual([
      ['d3-call', 'call', '2026-02-03'],
      ['d7-letter', 'letter', '2026-02-07'],
      ['m1-letter', 'letter', '2026-02-28'],
      ['m1-assessment', 'assessment', '2026-02-28'],
      ['m2-letter', 'letter', '2026-03-31'],
      ['m3-letter', 'letter', '2026-04-30'],
      ['m6-letter', 'letter', '2026-07-31'],
      ['m9-letter', 'letter', '2026-10-31'],
      ['m11-call', 'call', '2026-12-31'],
      ['m12-letter', 'letter', '2027-01-31'],
      ['m13-call', 'call', '2027-02-28'],
    ]);
    expect(new Set(s.map((c) => c.id)).size).toBe(s.length);
    expect(s.find((c) => c.id === 'm11-call')!.label).toBe('Pre-anniversary call');
  });

  it('closes 13 months after death', () => {
    expect(bereavementClosesOn('2026-01-31')).toBe('2027-02-28');
    expect(bereavementClosesOn('2026-09-26')).toBe('2027-10-26');
  });
});
