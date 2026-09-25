import { arrayRemove, arrayUnion, writeBatch } from 'firebase/firestore';
import { db } from './firebase';
import { orgDoc } from './firestore';

/**
 * Keep `members/{uid}.teamIds` and `teams/{id}.memberUids` in sync (admin only).
 * Pass the member's previous and next team ids.
 */
export async function setMemberTeams(orgId: string, uid: string, prev: string[], next: string[]): Promise<void> {
  const batch = writeBatch(db);
  batch.update(orgDoc(orgId, 'members', uid), { teamIds: next });
  for (const t of next.filter((t) => !prev.includes(t))) {
    batch.update(orgDoc(orgId, 'teams', t), { memberUids: arrayUnion(uid) });
  }
  for (const t of prev.filter((t) => !next.includes(t))) {
    batch.update(orgDoc(orgId, 'teams', t), { memberUids: arrayRemove(uid) });
  }
  await batch.commit();
}

/** Set a team's members and mirror the change into each member's `teamIds`. */
export async function setTeamMembers(orgId: string, teamId: string, prev: string[], next: string[]): Promise<void> {
  const batch = writeBatch(db);
  batch.update(orgDoc(orgId, 'teams', teamId), { memberUids: next });
  for (const uid of next.filter((u) => !prev.includes(u))) {
    batch.update(orgDoc(orgId, 'members', uid), { teamIds: arrayUnion(teamId) });
  }
  for (const uid of prev.filter((u) => !next.includes(u))) {
    batch.update(orgDoc(orgId, 'members', uid), { teamIds: arrayRemove(teamId) });
  }
  await batch.commit();
}
