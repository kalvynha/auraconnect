import { describe, expect, it } from 'vitest';
import { isVisitMissed, missedCutoffMs, selectMissedVisits } from '../../src/domain/visits';

const now = Date.parse('2026-09-26T12:00:00Z');
const min = 60_000;

describe('selectMissedVisits', () => {
  it('selects scheduled visits whose end is more than the grace period ago, oldest first', () => {
    const visits = [
      { id: 'late', status: 'scheduled', endMs: now - 121 * min },
      { id: 'edge', status: 'scheduled', endMs: now - 120 * min }, // exactly at grace: not yet
      { id: 'recent', status: 'scheduled', endMs: now - 30 * min },
      { id: 'older', status: 'scheduled', endMs: now - 600 * min },
      { id: 'done', status: 'completed', endMs: now - 600 * min },
      { id: 'cancelled', status: 'cancelled', endMs: now - 600 * min },
      { id: 'bad', status: 'scheduled', endMs: NaN },
    ];
    expect(selectMissedVisits(visits, now, 120).map((v) => v.id)).toEqual(['older', 'late']);
    expect(selectMissedVisits(visits, now, 15).map((v) => v.id)).toEqual(['older', 'late', 'edge', 'recent']);
  });

  it('isVisitMissed and the query cutoff agree', () => {
    expect(isVisitMissed({ status: 'scheduled', endMs: missedCutoffMs(now, 60) - 1 }, now, 60)).toBe(true);
    expect(isVisitMissed({ status: 'scheduled', endMs: missedCutoffMs(now, 60) }, now, 60)).toBe(false);
    expect(isVisitMissed({ status: 'missed', endMs: 0 }, now, 60)).toBe(false);
  });
});
