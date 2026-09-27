// v3 capability helpers (UI only — every callable re-checks on the server).
import type { Capability, Member } from '@shared/types';
import { useOrgSession } from './session';
import { CLINICAL_ROLES } from './constants';

/** Mirror of FIELD_DISCIPLINES: Aide/LPN viewers may complete their own visits. */
export const FIELD_DISCIPLINES = ['Aide', 'LPN'] as const;

export function memberHasCapability(m: Pick<Member, 'role' | 'capabilities'> | null | undefined, cap: Capability): boolean {
  return !!m && (m.role === 'admin' || (m.capabilities ?? []).includes(cap));
}

/** True for admins and members granted `cap`. */
export function useHasCapability(cap: Capability): boolean {
  const s = useOrgSession();
  return s.isAdmin || memberHasCapability(s.member, cap);
}

export interface VisitPermissionInput {
  status: string;
  assignedUid: string | null;
  createdBy: string;
}

/**
 * Mirrors the server's visit rules (functions/src/visits/visits.ts):
 *  - manage (reassign / reschedule / cancel): clinical role or `scheduling`, AND
 *    admin/`scheduling`, the care team, the assignee or the creator;
 *  - complete: the same, or an Aide/LPN viewer completing a visit assigned to them.
 * `careTeamUids` undefined = unknown (e.g. a list across patients): the care-team check is
 * assumed to pass and the server decides.
 */
export function useVisitPermissions() {
  const s = useOrgSession();
  const scheduler = memberHasCapability(s.member, 'scheduling');
  const clinical = CLINICAL_ROLES.includes(s.role);
  const field = !!s.member && (FIELD_DISCIPLINES as readonly string[]).includes(s.member.discipline);
  const involved = (v: VisitPermissionInput, careTeamUids?: readonly string[]) =>
    scheduler || careTeamUids === undefined || careTeamUids.includes(s.user.uid) || v.assignedUid === s.user.uid || v.createdBy === s.user.uid;
  const canManage = (v: VisitPermissionInput, careTeamUids?: readonly string[]) => (clinical || scheduler) && involved(v, careTeamUids);
  return {
    /** May open the schedule / plan tools at all. */
    canSchedule: clinical || scheduler,
    scheduler,
    canManage,
    canComplete: (v: VisitPermissionInput, careTeamUids?: readonly string[]) =>
      canManage(v, careTeamUids) || (field && v.assignedUid === s.user.uid),
    canCancel: (v: VisitPermissionInput, careTeamUids?: readonly string[]) => v.status === 'scheduled' && canManage(v, careTeamUids),
    canReassign: (v: VisitPermissionInput, careTeamUids?: readonly string[]) => v.status === 'scheduled' && canManage(v, careTeamUids),
    canReschedule: (v: VisitPermissionInput, careTeamUids?: readonly string[]) => v.status === 'missed' && canManage(v, careTeamUids),
    canBulkReassign: scheduler || memberHasCapability(s.member, 'staffing'),
  };
}
