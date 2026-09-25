/** Auth/role guards and input validation for callables. */
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { ZodType, ZodTypeDef } from 'zod';
import type { Role } from '../shared/types';

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
  role: Role;
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
 * Requires the caller to be signed in, belong to `orgId` (per custom claims)
 * and, when `roles` is given, hold one of them.
 */
export function requireOrg(request: AuthLike, orgId: string, roles?: readonly Role[]): OrgContext {
  const info = requireAuth(request);
  const claimOrg = info.claims.orgId;
  const claimRole = info.claims.role as Role | undefined;
  if (typeof claimOrg !== 'string' || !claimRole) {
    throw new HttpsError('permission-denied', 'You are not a member of an organization.');
  }
  if (claimOrg !== orgId) throw new HttpsError('permission-denied', 'Not a member of this organization.');
  if (roles && !roles.includes(claimRole)) {
    throw new HttpsError('permission-denied', 'Your role does not allow this action.');
  }
  return { ...info, orgId, role: claimRole };
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
