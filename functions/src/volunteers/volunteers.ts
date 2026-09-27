/**
 * Volunteer program callables (C2):
 *  - `voidVolunteerLog` (admin or `volunteers` capability): sets `voidedAt/voidedBy/voidReason`.
 *    Logs are otherwise immutable (rules deny client updates); voided logs are excluded from
 *    reports and metrics.
 *  - `volunteerComplianceReport` (admin, `reports` or `volunteers` capability): volunteer
 *    minutes vs staff patient-care minutes for a date range (see ./compliance.ts).
 *  - `onStaffHoursWritten`: audits client writes to `staffHours/{YYYY-MM}`.
 */
import { FieldValue, Timestamp, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { addDays, compareISO, diffDays } from '../domain/dates';
import { zonedMidnightMs } from '../domain/metrics';
import { writeAudit } from '../lib/audit';
import { carePaths, requireOrgDoc, tsMillis } from '../lib/care';
import { parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getMany } from '../lib/db';
import { memberHasCapability, requireCapability } from '../lib/permissions';
import { FIRESTORE_TRIGGER_REGION } from '../lib/regions';
import { id, isoDate } from '../lib/schemas';
import type {
  StaffHours,
  Visit,
  VoidVolunteerLogRequest,
  VolunteerComplianceMonth,
  VolunteerComplianceReportRequest,
  VolunteerComplianceReportResponse,
  VolunteerLog,
} from '../shared/types';
import { MAX_REPORT_DAYS, monthSegments, summarize, visitMinutes } from './compliance';
import { volunteerPaths } from './volunteerUids';

const voidSchema = z.object({ orgId: id, logId: id, reason: z.string().trim().min(1).max(500) });

export async function voidVolunteerLogHandler(request: CallableRequest<VoidVolunteerLogRequest>): Promise<Record<string, never>> {
  const input = parse(voidSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  await requireCapability(ctx, 'volunteers');
  const ref = docRef(volunteerPaths.log(ctx.orgId, input.logId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Volunteer log not found.');
    const log = snap.data() as VolunteerLog;
    if (log.voidedAt) throw new HttpsError('failed-precondition', 'This log is already voided.');
    tx.update(ref, { voidedAt: FieldValue.serverTimestamp(), voidedBy: ctx.uid, voidReason: input.reason });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'volunteer.void',
        resourceType: 'volunteerLog',
        resourceId: input.logId,
        patientId: log.patientId ?? null,
        metadata: { volunteerUid: log.volunteerUid, date: log.date, minutes: log.minutes },
      },
      tx,
    );
  });
  return {};
}

const reportSchema = z
  .object({ orgId: id, from: isoDate, to: isoDate })
  .refine((v) => compareISO(v.from, v.to) <= 0, 'from must not be after to')
  .refine((v) => diffDays(v.from, v.to) < MAX_REPORT_DAYS, `The range can be at most ${MAX_REPORT_DAYS} days.`);

/** Read caps: the report returns `truncated: true` when one is hit. */
export const MAX_REPORT_LOGS = 20_000;
export const MAX_VISITS_PER_MONTH = 10_000;
const PAGE = 1000;

export async function volunteerComplianceReportHandler(request: CallableRequest<VolunteerComplianceReportRequest>): Promise<VolunteerComplianceReportResponse> {
  const input = parse(reportSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  if (!memberHasCapability(ctx.member, 'reports') && !memberHasCapability(ctx.member, 'volunteers')) {
    throw new HttpsError('permission-denied', 'This report needs the "reports" or "volunteers" permission.');
  }
  const org = await requireOrgDoc(ctx.orgId);
  const tz = org.timezone || 'UTC';
  const segments = monthSegments(input.from, input.to);
  let truncated = false;

  // Volunteer minutes by month (voided excluded), paged by date.
  const volunteerByMonth = new Map<string, number>();
  let voidedLogsExcluded = 0;
  let scanned = 0;
  const logBase = colRef(volunteerPaths.logs(ctx.orgId)).where('date', '>=', input.from).where('date', '<=', input.to).orderBy('date');
  let lastLog: QueryDocumentSnapshot | null = null;
  for (;;) {
    const snap = await (lastLog ? logBase.startAfter(lastLog) : logBase).limit(PAGE).get();
    for (const d of snap.docs) {
      const l = d.data() as VolunteerLog;
      if (l.voidedAt) {
        voidedLogsExcluded++;
        continue;
      }
      const m = String(l.date).slice(0, 7);
      volunteerByMonth.set(m, (volunteerByMonth.get(m) ?? 0) + (Number(l.minutes) || 0));
    }
    scanned += snap.docs.length;
    if (snap.docs.length < PAGE) break;
    if (scanned >= MAX_REPORT_LOGS) {
      truncated = true;
      break;
    }
    lastLog = snap.docs[snap.docs.length - 1]!;
  }

  // Staff minutes: override per month, else completed visits in the segment.
  const overrides = await getMany<StaffHours>(segments.map((s) => `${volunteerPaths.staffHours(ctx.orgId)}/${s.month}`));
  const months: VolunteerComplianceMonth[] = [];
  for (const seg of segments) {
    const override = overrides.get(`${volunteerPaths.staffHours(ctx.orgId)}/${seg.month}`);
    let staffMinutes = 0;
    let staffSource: VolunteerComplianceMonth['staffSource'] = 'visits';
    if (override && Number.isFinite(override.paidCareHours)) {
      staffSource = 'override';
      staffMinutes = Math.round(override.paidCareHours * 60 * seg.fraction);
    } else {
      const startTs = Timestamp.fromMillis(zonedMidnightMs(seg.from, tz));
      const endTs = Timestamp.fromMillis(zonedMidnightMs(addDays(seg.to, 1), tz));
      const vBase = colRef(carePaths.visits(ctx.orgId))
        .where('status', '==', 'completed')
        .where('scheduledStart', '>=', startTs)
        .where('scheduledStart', '<', endTs)
        .orderBy('scheduledStart');
      let lastVisit: QueryDocumentSnapshot | null = null;
      let count = 0;
      for (;;) {
        const snap = await (lastVisit ? vBase.startAfter(lastVisit) : vBase).limit(PAGE).get();
        for (const d of snap.docs) {
          const v = d.data() as Visit;
          staffMinutes += visitMinutes(tsMillis(v.scheduledStart), tsMillis(v.scheduledEnd));
        }
        count += snap.docs.length;
        if (snap.docs.length < PAGE) break;
        if (count >= MAX_VISITS_PER_MONTH) {
          truncated = true;
          break;
        }
        lastVisit = snap.docs[snap.docs.length - 1]!;
      }
    }
    months.push({ month: seg.month, volunteerMinutes: volunteerByMonth.get(seg.month) ?? 0, staffMinutes, staffSource });
  }

  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'volunteer.report',
    resourceType: 'org',
    resourceId: ctx.orgId,
    metadata: { from: input.from, to: input.to, truncated },
  });
  return { from: input.from, to: input.to, ...summarize(months), months, voidedLogsExcluded, truncated };
}

/** Audits admin / `reports` writes to `staffHours/{YYYY-MM}` (clients write it directly). */
export async function handleStaffHoursWritten(orgId: string, month: string, before: StaffHours | null, after: StaffHours | null): Promise<void> {
  await writeAudit(orgId, {
    actorUid: after?.updatedBy ?? 'unknown',
    action: 'volunteer.staff_hours',
    resourceType: 'staffHours',
    resourceId: month,
    metadata: { paidCareHours: after?.paidCareHours ?? null, previous: before?.paidCareHours ?? null, deleted: !after },
  });
}

export const onStaffHoursWritten = onDocumentWritten(
  { document: 'orgs/{orgId}/staffHours/{month}', region: FIRESTORE_TRIGGER_REGION },
  async (event) => {
    const before = event.data?.before.exists ? (event.data.before.data() as StaffHours) : null;
    const after = event.data?.after.exists ? (event.data.after.data() as StaffHours) : null;
    await handleStaffHoursWritten(event.params.orgId, event.params.month, before, after);
  },
);

export const voidVolunteerLog = onCall(voidVolunteerLogHandler);
export const volunteerComplianceReport = onCall({ timeoutSeconds: 120 }, volunteerComplianceReportHandler);
