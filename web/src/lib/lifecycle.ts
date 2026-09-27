// Clinical safety and lifecycle helpers (runtime mirrors of @shared/types constants, which the
// web may only import as types).
import type { Discipline, Member, MilestoneKind } from '@shared/types';
import { useOrgSession } from './session';

/** Mirror of LICENSED_DISCIPLINES: may record death/discharge, change level of care, recertify, reopen milestones, edit the clinical record. */
export const LICENSED_DISCIPLINES: readonly Discipline[] = ['RN', 'NP', 'MD'];

/** Mirror of DEADLINE_LEAD_DAYS_DEFAULTS. */
export const DEADLINE_LEAD_DAYS_DEFAULTS: Record<MilestoneKind, number> = {
  noe: 3,
  recert: 15,
  f2f: 30,
  hope_admission: 2,
  hope_huv1: 2,
  hope_huv2: 2,
};

export function memberIsLicensed(m: Pick<Member, 'role' | 'discipline'> | null | undefined): boolean {
  return !!m && (m.role === 'admin' || LICENSED_DISCIPLINES.includes(m.discipline));
}

/** True when the signed-in member is an admin or an RN/NP/MD (the server re-checks). */
export function useIsLicensed(): boolean {
  const s = useOrgSession();
  return memberIsLicensed(s.member ?? (s.role === 'admin' ? { role: 'admin', discipline: 'Admin' } : null));
}

/** H4: who may mark a milestone complete — licensed staff or admins; intake may file the NOE. */
export function canCompleteMilestoneKind(licensed: boolean, role: string, kind: MilestoneKind): boolean {
  return licensed || (role === 'intake' && kind === 'noe');
}
