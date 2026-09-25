import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { DEFAULT_ESCALATION_POLICY } from '../domain/escalation';
import { writeAudit } from '../lib/audit';
import { setOrgClaims } from '../lib/claims';
import { parse, requireAuth } from '../lib/context';
import { colRef, db, docRef, paths } from '../lib/db';
import { discipline, timeZone } from '../lib/schemas';
import type { CreateOrgRequest, CreateOrgResponse } from '../shared/types';

const schema = z.object({
  name: z.string().trim().min(1).max(200),
  timezone: timeZone,
  displayName: z.string().trim().min(1).max(200),
  discipline,
});

export async function createOrgHandler(request: CallableRequest<CreateOrgRequest>): Promise<CreateOrgResponse> {
  const auth = requireAuth(request);
  const input = parse(schema, request.data);
  if (typeof auth.claims.orgId === 'string') {
    throw new HttpsError('already-exists', 'You already belong to an organization.');
  }

  const orgRef = colRef('orgs').doc();
  const orgId = orgRef.id;
  const policyRef = colRef(paths.escalationPolicies(orgId)).doc();

  await db().runTransaction(async (tx) => {
    const userOrg = await tx.get(docRef(paths.userOrg(auth.uid)));
    if (userOrg.exists) throw new HttpsError('already-exists', 'You already belong to an organization.');
    const now = FieldValue.serverTimestamp();
    tx.create(orgRef, {
      name: input.name,
      timezone: input.timezone,
      deadlineLeadDays: 3,
      defaultEscalationPolicyId: policyRef.id,
      createdBy: auth.uid,
      createdAt: now,
    });
    tx.create(policyRef, { ...DEFAULT_ESCALATION_POLICY });
    tx.create(docRef(paths.member(orgId, auth.uid)), {
      uid: auth.uid,
      email: auth.email ?? '',
      displayName: input.displayName,
      role: 'admin',
      discipline: input.discipline,
      title: null,
      phone: null,
      teamIds: [],
      active: true,
      fcmTokens: [],
      createdAt: now,
    });
    tx.set(docRef(paths.userOrg(auth.uid)), { orgId, role: 'admin' });
    await writeAudit(orgId, { actorUid: auth.uid, action: 'org.create', resourceType: 'org', resourceId: orgId }, tx);
  });

  await setOrgClaims(auth.uid, orgId, 'admin');
  return { orgId };
}

export const createOrg = onCall(createOrgHandler);
