/**
 * IDG (interdisciplinary group) review rules. Pure module: no Firebase imports.
 *
 *  - `nextIdgDueDate` = `lastIdgReviewDate` (or `admissionDate`) + `idgCadenceDays`.
 *  - A meeting's auto-agenda holds admitted patients whose next due date is on
 *    or before the meeting date + 7 days. Patients written before v2 lack
 *    `nextIdgDueDate`; it is derived from their review/admission date instead.
 */
import type { ISODate, Patient } from '../shared/types';
import { addDays, compareISO, isValidISODate } from './dates';

export const IDG_AGENDA_LOOKAHEAD_DAYS = 7;

export type IdgPatientFields = Pick<Patient, 'status' | 'admissionDate' | 'lastIdgReviewDate' | 'nextIdgDueDate'>;

export function nextIdgDue(fromDate: ISODate, cadenceDays: number): ISODate {
  return addDays(fromDate, Math.max(1, Math.floor(cadenceDays)));
}

/** The patient's effective next IDG due date, or null when it can't be determined. */
export function effectiveNextIdgDue(p: IdgPatientFields, cadenceDays: number): ISODate | null {
  if (p.nextIdgDueDate && isValidISODate(p.nextIdgDueDate)) return p.nextIdgDueDate;
  const base = p.lastIdgReviewDate ?? p.admissionDate;
  return base && isValidISODate(base) ? nextIdgDue(base, cadenceDays) : null;
}

/** Ids of admitted patients due for review by `meetingDate` + 7 days, ordered by due date. */
export function selectIdgAgenda<T extends IdgPatientFields & { id: string }>(
  patients: readonly T[],
  meetingDate: ISODate,
  cadenceDays: number,
): string[] {
  const horizon = addDays(meetingDate, IDG_AGENDA_LOOKAHEAD_DAYS);
  return patients
    .filter((p) => p.status === 'admitted')
    .map((p) => ({ id: p.id, due: effectiveNextIdgDue(p, cadenceDays) }))
    .filter((x): x is { id: string; due: ISODate } => x.due !== null && compareISO(x.due, horizon) <= 0)
    .sort((a, b) => compareISO(a.due, b.due) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((x) => x.id);
}
