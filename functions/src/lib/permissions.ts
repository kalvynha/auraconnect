/**
 * v3 permission helpers layered on top of `requireOrg` (role claims):
 *  - capabilities: admin-granted extras (`Member.capabilities`); admins hold all.
 *  - licensed acts: death, discharge, level of care, recert, milestone reopen, clinical
 *    updates — admin, or a member whose discipline is RN/NP/MD.
 * These read the caller's member doc (claims carry only orgId/role), so capability and
 * discipline changes take effect immediately.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import { getDocData, paths } from './db';
import type { OrgContext } from './context';
import { LICENSED_DISCIPLINES, type Capability, type Member } from '../shared/types';

export async function loadCallerMember(ctx: Pick<OrgContext, 'orgId' | 'uid'>): Promise<Member> {
  const member = await getDocData<Member>(paths.member(ctx.orgId, ctx.uid));
  if (!member || !member.active) throw new HttpsError('permission-denied', 'Your membership is not active.');
  return member;
}

export function memberHasCapability(member: Pick<Member, 'role' | 'capabilities'>, cap: Capability): boolean {
  return member.role === 'admin' || (member.capabilities ?? []).includes(cap);
}

export function memberIsLicensed(member: Pick<Member, 'role' | 'discipline'>): boolean {
  return member.role === 'admin' || LICENSED_DISCIPLINES.includes(member.discipline);
}

/** Throws unless the caller is an admin or holds `cap`. Returns the caller's member doc. */
export async function requireCapability(ctx: OrgContext, cap: Capability): Promise<Member> {
  const member = ctx.member ?? (await loadCallerMember(ctx));
  if (!memberHasCapability(member, cap)) {
    throw new HttpsError('permission-denied', `This action needs the "${cap}" permission.`);
  }
  return member;
}

/** Throws unless the caller is an admin or an RN/NP/MD. Returns the caller's member doc. */
export async function requireLicensed(ctx: OrgContext): Promise<Member> {
  const member = ctx.member ?? (await loadCallerMember(ctx));
  if (!memberIsLicensed(member)) {
    throw new HttpsError('permission-denied', 'Only an RN, NP, MD or administrator can do this.');
  }
  return member;
}
