/**
 * Bereavement follow-up schedule (13 months after death). Pure module: no Firebase imports.
 *
 * Default contacts (docs/DATA_MODEL.md, "Death"): condolence call day 3,
 * sympathy letter day 7, letters at months 1, 2, 3, 6 and 9, pre-anniversary
 * call month 11, anniversary letter month 12, closing call month 13.
 * The plan closes at death date + 13 months.
 *
 * Month arithmetic clamps to the end of the month: Jan 31 + 1 month = Feb 28
 * (or 29 in a leap year), never Mar 3.
 */
import type { BereavementContactType, ISODate } from '../shared/types';
import { addDays, isoToUtcMillis } from './dates';

export const BEREAVEMENT_MONTHS = 13;

/** `iso` plus `months` calendar months, clamped to the last day of the target month. */
export function addMonthsClamped(iso: ISODate, months: number): ISODate {
  const d = new Date(isoToUtcMillis(iso));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + Math.trunc(months);
  const day = d.getUTCDate();
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
  return out.toISOString().slice(0, 10);
}

export interface ScheduledContact {
  id: string;
  type: BereavementContactType;
  label: string;
  dueDate: ISODate;
}

interface ContactSpec {
  id: string;
  type: BereavementContactType;
  label: string;
  days?: number;
  months?: number;
}

export const DEFAULT_BEREAVEMENT_CONTACTS: readonly ContactSpec[] = [
  { id: 'd3-call', type: 'call', label: 'Condolence call', days: 3 },
  { id: 'd7-letter', type: 'letter', label: 'Sympathy letter', days: 7 },
  { id: 'm1-letter', type: 'letter', label: 'Bereavement letter (month 1)', months: 1 },
  { id: 'm2-letter', type: 'letter', label: 'Bereavement letter (month 2)', months: 2 },
  { id: 'm3-letter', type: 'letter', label: 'Bereavement letter (month 3)', months: 3 },
  { id: 'm6-letter', type: 'letter', label: 'Bereavement letter (month 6)', months: 6 },
  { id: 'm9-letter', type: 'letter', label: 'Bereavement letter (month 9)', months: 9 },
  { id: 'm11-call', type: 'call', label: 'Pre-anniversary call', months: 11 },
  { id: 'm12-letter', type: 'letter', label: 'Anniversary letter', months: 12 },
  { id: 'm13-call', type: 'call', label: 'Closing call', months: 13 },
];

/** The default contact schedule for a death on `deathDate`, sorted by due date. */
export function buildBereavementSchedule(deathDate: ISODate): ScheduledContact[] {
  return DEFAULT_BEREAVEMENT_CONTACTS.map((c) => ({
    id: c.id,
    type: c.type,
    label: c.label,
    dueDate: c.months !== undefined ? addMonthsClamped(deathDate, c.months) : addDays(deathDate, c.days ?? 0),
  }));
}

/** Date the plan closes: death date + 13 months (clamped). */
export function bereavementClosesOn(deathDate: ISODate): ISODate {
  return addMonthsClamped(deathDate, BEREAVEMENT_MONTHS);
}
