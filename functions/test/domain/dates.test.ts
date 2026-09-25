import { describe, expect, it } from 'vitest';
import { addDays, diffDays, isValidISODate, isValidTimeZone, localDateParts, todayInTimeZone } from '../../src/domain/dates';

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isValidISODate('2026-02-28')).toBe(true);
    expect(isValidISODate('2028-02-29')).toBe(true);
    expect(isValidISODate('2026-02-29')).toBe(false);
    expect(isValidISODate('2026-13-01')).toBe(false);
    expect(isValidISODate('2026-1-01')).toBe(false);
    expect(isValidISODate('01/02/2026')).toBe(false);
    expect(isValidISODate(null)).toBe(false);
  });

  it('adds and diffs days across month/year/leap boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
    expect(diffDays('2028-01-01', '2028-12-31')).toBe(365);
  });

  it('is unaffected by DST transitions (UTC arithmetic)', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('computes local "today" in an org time zone', () => {
    const instant = new Date('2026-10-01T03:30:00Z');
    expect(todayInTimeZone(instant, 'UTC')).toBe('2026-10-01');
    expect(todayInTimeZone(instant, 'America/Los_Angeles')).toBe('2026-09-30');
    expect(localDateParts(new Date('2026-10-01T11:00:00Z'), 'America/New_York')).toEqual({ date: '2026-10-01', hour: 7 });
    expect(todayInTimeZone(instant, 'Not/AZone')).toBe('2026-10-01');
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
  });
});
