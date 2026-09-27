/**
 * Compliance (L4) and census reports. Admins and `reports` holders; each run is audited
 * (`report.compliance` / `report.census`, no PHI in metadata).
 *
 * Both scan admitted patients plus patients discharged (`dischargeDate`) or deceased
 * (`death.date`) on or after `from`, i.e. everyone who could have been served in the range.
 * Indexes: patients(status, dischargeDate), patients(status, death.date).
 */
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { compareISO, diffDays, todayInTimeZone } from '../domain/dates';
import { completionDate } from '../domain/milestones';
import { censusSummary, complianceRows, MAX_REPORT_DAYS, type CensusPatient, type CompletionLike } from '../domain/reports';
import { writeAudit } from '../lib/audit';
import { orgSettings, patientDisplayName, requireOrgDoc, tsMillis } from '../lib/care';
import { parse, requireOrg } from '../lib/context';
import { colRef, paths } from '../lib/db';
import { requireCapability } from '../lib/permissions';
import { id, isoDate } from '../lib/schemas';
import type {
  CensusReportRequest,
  CensusReportResponse,
  ComplianceReportRequest,
  ComplianceReportResponse,
  ISODate,
  MilestoneKind,
  Patient,
} from '../shared/types';

const range = { orgId: id, from: isoDate, to: isoDate };
const complianceSchema = z.object({ ...range, kinds: z.array(z.string().min(1).max(40)).min(1).max(20) });
const censusSchema = z.object(range);

function assertRange(from: ISODate, to: ISODate): void {
  if (compareISO(from, to) > 0) throw new HttpsError('invalid-argument', '"from" must be on or before "to".');
  if (diffDays(from, to) + 1 > MAX_REPORT_DAYS) throw new HttpsError('invalid-argument', `The range can be at most ${MAX_REPORT_DAYS} days.`);
}

/** Admitted patients plus those whose care ended on or after `from`. */
export async function patientsServedSince(orgId: string, from: ISODate): Promise<Array<{ id: string; p: Patient }>> {
  const col = colRef(paths.patients(orgId));
  const [admitted, discharged, deceased] = await Promise.all([
    col.where('status', '==', 'admitted').get(),
    col.where('status', '==', 'discharged').where('dischargeDate', '>=', from).get(),
    col.where('status', '==', 'deceased').where('death.date', '>=', from).get(),
  ]);
  const byId = new Map<string, Patient>();
  for (const d of [...admitted.docs, ...discharged.docs, ...deceased.docs]) byId.set(d.id, d.data() as Patient);
  return [...byId.entries()].map(([pid, p]) => ({ id: pid, p }));
}

export function endOfCare(p: Patient): { endDate: ISODate | null; endReason: CensusPatient['endReason'] } {
  if (p.status === 'deceased') return { endDate: p.death?.date ?? p.dischargeDate ?? null, endReason: 'death' };
  if (p.status === 'discharged') return { endDate: p.dischargeDate ?? null, endReason: p.dischargeReason ?? 'other' };
  return { endDate: null, endReason: null };
}

export async function complianceReportHandler(request: CallableRequest<ComplianceReportRequest>): Promise<ComplianceReportResponse> {
  const input = parse(complianceSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  await requireCapability(ctx, 'reports');
  assertRange(input.from, input.to);
  const tz = orgSettings(await requireOrgDoc(ctx.orgId)).timezone;
  const today = todayInTimeZone(new Date(), tz);
  const kinds = new Set(input.kinds as MilestoneKind[]);
  const patients = await patientsServedSince(ctx.orgId, input.from);
  const localDateOf = (at: unknown): ISODate | null => {
    const ms = tsMillis(at as { seconds: number } | null);
    return Number.isFinite(ms) ? todayInTimeZone(new Date(ms), tz) : null;
  };

  const rows = patients.flatMap(({ id: pid, p }) => {
    // S5: judged from completionDate() — effectiveDate when recorded, else the local date of completedAt.
    const completions: Record<string, CompletionLike> = {};
    for (const [key, c] of Object.entries(p.milestoneCompletions ?? {})) {
      completions[key] = { effectiveDate: completionDate(c, localDateOf), completedDate: null, completedBy: c?.completedBy ?? null };
    }
    return complianceRows(
      { patientId: pid, patientName: patientDisplayName(p), mrn: p.mrn ?? null, milestones: p.milestones ?? null, completions, endDate: endOfCare(p).endDate },
      input.from,
      input.to,
      kinds,
      today,
    );
  });
  rows.sort((a, b) => compareISO(a.due, b.due) || a.patientName.localeCompare(b.patientName) || a.kind.localeCompare(b.kind));

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'report.compliance',
    resourceType: 'report',
    resourceId: 'compliance',
    metadata: { from: input.from, to: input.to, kinds: [...kinds], rows: rows.length, byStatus },
  });
  return { from: input.from, to: input.to, rows, patientsScanned: patients.length };
}

export async function censusReportHandler(request: CallableRequest<CensusReportRequest>): Promise<CensusReportResponse> {
  const input = parse(censusSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  await requireCapability(ctx, 'reports');
  assertRange(input.from, input.to);
  const patients = await patientsServedSince(ctx.orgId, input.from);
  const summary = censusSummary(
    patients.map(({ id: pid, p }) => ({
      patientId: pid,
      patientName: patientDisplayName(p),
      mrn: p.mrn ?? null,
      status: p.status,
      levelOfCare: p.levelOfCare,
      admissionDate: p.admissionDate ?? null,
      ...endOfCare(p),
    })),
    input.from,
    input.to,
  );
  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'report.census',
    resourceType: 'report',
    resourceId: 'census',
    metadata: { from: input.from, to: input.to, patients: summary.roster.length },
  });
  return { from: input.from, to: input.to, ...summary };
}

export const complianceReport = onCall({ timeoutSeconds: 120 }, complianceReportHandler);
export const censusReport = onCall({ timeoutSeconds: 120 }, censusReportHandler);
