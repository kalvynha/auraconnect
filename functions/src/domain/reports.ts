/**
 * Compliance (L4) and census report rules. Pure module: no Firebase imports.
 */
import { addDays, compareISO, diffDays } from './dates';
import { allMilestoneKeys, parseMilestoneKey } from './milestones';
import type {
  CensusRosterRow,
  ComplianceRow,
  ComplianceRowStatus,
  DischargeReason,
  ISODate,
  LevelOfCare,
  MilestoneKind,
  Milestones,
  PatientStatus,
} from '../shared/types';

/** Longest report range, in days (inclusive). */
export const MAX_REPORT_DAYS = 400;

export interface CompletionLike {
  /** Org-local filing date when recorded (S5), else null. */
  effectiveDate: ISODate | null;
  /** Org-local date of `completedAt`. */
  completedDate: ISODate | null;
  completedBy: string | null;
}

export interface ComplianceInput {
  patientId: string;
  patientName: string;
  mrn: string | null;
  milestones: Milestones | null;
  completions: Record<string, CompletionLike>;
  /** Discharge date or date of death; milestones due after it are not owed (unless completed). */
  endDate: ISODate | null;
}

/**
 * One row per milestone key due in [from, to] whose kind is in `kinds`.
 * - completed: `on_time` when the effective date ≤ due, else `late` (daysLate = effective − due)
 * - not completed: `overdue` when due < today (daysLate = today − due), else `open`
 */
export function complianceRows(p: ComplianceInput, from: ISODate, to: ISODate, kinds: ReadonlySet<MilestoneKind>, today: ISODate): ComplianceRow[] {
  if (!p.milestones) return [];
  const rows: ComplianceRow[] = [];
  for (const key of allMilestoneKeys(p.milestones)) {
    const parsed = parseMilestoneKey(key);
    if (!parsed || !kinds.has(parsed.kind)) continue;
    const due = parsed.dueDate;
    if (compareISO(due, from) < 0 || compareISO(due, to) > 0) continue;
    const c = p.completions[key];
    if (!c && p.endDate && compareISO(due, p.endDate) > 0) continue;
    const effective = c ? (c.effectiveDate ?? c.completedDate) : null;
    let status: ComplianceRowStatus;
    let daysLate = 0;
    if (c) {
      const late = effective ? diffDays(due, effective) : 0;
      status = late > 0 ? 'late' : 'on_time';
      daysLate = Math.max(0, late);
    } else if (compareISO(due, today) < 0) {
      status = 'overdue';
      daysLate = diffDays(due, today);
    } else {
      status = 'open';
    }
    rows.push({
      patientId: p.patientId,
      patientName: p.patientName,
      mrn: p.mrn,
      kind: parsed.kind,
      key,
      due,
      effectiveDate: effective,
      completedBy: c?.completedBy ?? null,
      daysLate,
      status,
    });
  }
  return rows;
}

export interface CensusPatient {
  patientId: string;
  patientName: string;
  mrn: string | null;
  status: PatientStatus;
  levelOfCare: LevelOfCare;
  admissionDate: ISODate | null;
  endDate: ISODate | null;
  endReason: DischargeReason | 'death' | null;
}

/** On census on day `d`: admitted on or before `d` and not yet discharged/died (the end day is not counted). */
export function onCensus(p: Pick<CensusPatient, 'admissionDate' | 'endDate'>, d: ISODate): boolean {
  if (!p.admissionDate || compareISO(p.admissionDate, d) > 0) return false;
  return !p.endDate || compareISO(p.endDate, d) > 0;
}

export interface CensusSummary {
  censusAtStart: number;
  censusAtEnd: number;
  averageDailyCensus: number;
  admissions: number;
  discharges: number;
  deaths: number;
  dischargesByReason: Partial<Record<DischargeReason, number>>;
  roster: CensusRosterRow[];
}

export function censusSummary(patients: readonly CensusPatient[], from: ISODate, to: ISODate): CensusSummary {
  const days = Math.max(1, diffDays(from, to) + 1);
  const inRange = (d: ISODate | null) => !!d && compareISO(d, from) >= 0 && compareISO(d, to) <= 0;
  const roster: CensusRosterRow[] = [];
  let patientDays = 0;
  let admissions = 0;
  let discharges = 0;
  let deaths = 0;
  const byReason: Partial<Record<DischargeReason, number>> = {};
  for (const p of patients) {
    if (!p.admissionDate || compareISO(p.admissionDate, to) > 0) continue;
    if (p.endDate && compareISO(p.endDate, from) < 0) continue;
    let served = 0;
    for (let i = 0; i < days; i++) if (onCensus(p, addDays(from, i))) served++;
    const endsInRange = inRange(p.endDate);
    if (served === 0 && !inRange(p.admissionDate) && !endsInRange) continue;
    patientDays += served;
    if (inRange(p.admissionDate)) admissions++;
    if (endsInRange) {
      if (p.endReason === 'death') deaths++;
      else {
        discharges++;
        if (p.endReason) byReason[p.endReason] = (byReason[p.endReason] ?? 0) + 1;
      }
    }
    roster.push({
      patientId: p.patientId,
      patientName: p.patientName,
      mrn: p.mrn,
      status: p.status,
      levelOfCare: p.levelOfCare,
      admissionDate: p.admissionDate,
      endDate: p.endDate,
      endReason: p.endReason,
      daysInRange: served,
    });
  }
  roster.sort((a, b) => a.patientName.localeCompare(b.patientName));
  return {
    censusAtStart: patients.filter((p) => onCensus(p, from)).length,
    censusAtEnd: patients.filter((p) => onCensus(p, to)).length,
    averageDailyCensus: Math.round((patientDays / days) * 10) / 10,
    admissions,
    discharges,
    deaths,
    dischargesByReason: byReason,
    roster,
  };
}
