/** Audit log writer (`orgs/{orgId}/auditLogs`). Never put PHI in metadata. */
import { FieldValue, type Transaction, type WriteBatch } from 'firebase-admin/firestore';
import type { AuditAction } from '../shared/types';
import { colRef, paths } from './db';

export interface AuditEntry {
  actorUid: string;
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  patientId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Writes an audit entry, optionally as part of a transaction or batch. */
export async function writeAudit(orgId: string, entry: AuditEntry, writer?: Transaction | WriteBatch): Promise<void> {
  const ref = colRef(paths.auditLogs(orgId)).doc();
  const data = {
    actorUid: entry.actorUid,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    patientId: entry.patientId ?? null,
    at: FieldValue.serverTimestamp(),
    metadata: entry.metadata ?? {},
  };
  if (writer) {
    (writer as Transaction).set(ref, data);
    return;
  }
  await ref.set(data);
}
