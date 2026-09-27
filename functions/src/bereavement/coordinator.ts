/**
 * Default bereavement coordinator for a new plan (C1). Used by `recordDeath` when no
 * `bereavementAssigneeUid` is given: the org's `defaultBereavementCoordinatorUid` if that
 * member is active, otherwise the first SW on the care team, otherwise unassigned.
 */
import type { CareTeamMemberRef } from '../domain/taskTemplates';
import { getDocData, paths } from '../lib/db';
import { loadActiveMembers } from '../lib/members';
import type { Org } from '../shared/types';

/** The org setting, when it names an active member (1 org read + at most 1 member read). */
export async function defaultBereavementCoordinator(orgId: string): Promise<string | null> {
  const org = await getDocData<Pick<Org, 'defaultBereavementCoordinatorUid'>>(paths.org(orgId));
  const uid = org?.defaultBereavementCoordinatorUid;
  if (!uid) return null;
  const active = await loadActiveMembers(orgId, [uid]);
  return active.has(uid) ? uid : null;
}

/** Org default coordinator, else the care team's first SW, else null. */
export async function resolveBereavementCoordinator(orgId: string, team: readonly CareTeamMemberRef[]): Promise<string | null> {
  return (await defaultBereavementCoordinator(orgId)) ?? team.find((m) => m.discipline === 'SW')?.uid ?? null;
}
