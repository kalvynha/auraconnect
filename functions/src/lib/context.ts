/** Auth/role guards and input validation for callables. */
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { ZodType, ZodTypeDef } from 'zod';
import type { Member, Role } from '../shared/types';
import { getDocData, paths } from './db';

export const WRITER_ROLES: readonly Role[] = ['admin', 'clinician', 'intake'];
export const CLINICAL_ROLES: readonly Role[] = ['admin', 'clinician', 'intake'];

export interface AuthInfo {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  claims: Record<string, unknown>;
}

export interface OrgContext extends AuthInfo {
  orgId: string;
  /** The caller's current role, read from their member doc (not the possibly stale token). */
  role: Role;
  /** The caller's member doc, loaded on every call. */
  member: Member;
}

type AuthLike = Pick<CallableRequest<unknown>, 'auth'>;

export function requireAuth(request: AuthLike): AuthInfo {
  const auth = request.auth;
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const token = (auth.token ?? {}) as Record<string, unknown>;
  const email = typeof token.email === 'string' ? token.email.toLowerCase() : null;
  return { uid: auth.uid, email, emailVerified: token.email_verified === true, claims: token };
}

/**
 * Requires the caller to be signed in, belong to `orgId` and, when `roles` is
 * given, hold one of them.
 *
 * Claims are only a first gate: ID tokens stay valid for up to an hour after a
 * member is deactivated or demoted, so the member doc is re-read on every call
 * and is authoritative for `active` and `role` (matching the security rules).
 */
export async function requireOrg(request: AuthLike, orgId: string, roles?: readonly Role[]): Promise<OrgContext> {
  const info = requireAuth(request);
  const claimOrg = info.claims.orgId;
  if (typeof claimOrg !== 'string' || !info.claims.role) {
    throw new HttpsError('permission-denied', 'You are not a member of an organization.');
  }
  if (claimOrg !== orgId) throw new HttpsError('permission-denied', 'Not a member of this organization.');
  const member = await getDocData<Member>(paths.member(orgId, info.uid));
  if (!member || member.active !== true) {
    throw new HttpsError('permission-denied', 'Your membership is not active.');
  }
  if (roles && !roles.includes(member.role)) {
    throw new HttpsError('permission-denied', 'Your role does not allow this action.');
  }
  return { ...info, orgId, role: member.role, member };
}

/** Validates `data` with a zod schema, mapping failures to `invalid-argument`. */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const res = schema.safeParse(data ?? {});
  if (!res.success) {
    const issue = res.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpsError('invalid-argument', `Invalid request. ${where}${issue?.message ?? ''}`.trim());
  }
  return res.data;
}
