/**
 * Visit rules. Pure module: no Firebase imports.
 *
 * A `scheduled` visit becomes `missed` once its `scheduledEnd` is more than
 * `graceMinutes` in the past (strictly: end + grace < now).
 */

export interface VisitSpan {
  id: string;
  status: string;
  endMs: number;
}

/** True when a scheduled visit with this end time is past its grace period at `nowMs`. */
export function isVisitMissed(v: Pick<VisitSpan, 'status' | 'endMs'>, nowMs: number, graceMinutes: number): boolean {
  if (v.status !== 'scheduled' || !Number.isFinite(v.endMs)) return false;
  return v.endMs + Math.max(0, graceMinutes) * 60_000 < nowMs;
}

/** Visits that should be marked missed now, oldest end first. */
export function selectMissedVisits<T extends VisitSpan>(visits: readonly T[], nowMs: number, graceMinutes: number): T[] {
  return visits.filter((v) => isVisitMissed(v, nowMs, graceMinutes)).sort((a, b) => a.endMs - b.endMs);
}

/** Latest scheduledEnd (ms) that counts as missed at `nowMs`; used as the query bound. */
export function missedCutoffMs(nowMs: number, graceMinutes: number): number {
  return nowMs - Math.max(0, graceMinutes) * 60_000;
}

// ---------------------------------------------------------------------------
// v3 (V1): missed-visit alert recipients
// ---------------------------------------------------------------------------

export type MissedVisitMode = 'assignee' | 'assignee_admins' | 'digest' | 'off';

export interface MissedVisitPeople {
  /** The visit's assignee when they are an active member. */
  assignee: string | null;
  /** Active care-team members in care-team order, with discipline. */
  careTeam: ReadonlyArray<{ uid: string; discipline: string }>;
  admins: readonly string[];
}

/**
 * Per-visit missed alert recipients for `mode`. Empty for `digest`/`off` (no per-visit alert).
 * Assigned → the assignee. Unassigned (or inactive assignee) → the care-team RN(s), else the
 * whole active care team. `assignee_admins` adds the admins; an empty result falls back to admins.
 */
export function missedVisitRecipients(mode: MissedVisitMode, people: MissedVisitPeople): string[] {
  if (mode === 'digest' || mode === 'off') return [];
  let primary: string[];
  if (people.assignee) primary = [people.assignee];
  else {
    const rns = people.careTeam.filter((m) => m.discipline === 'RN').map((m) => m.uid);
    primary = rns.length > 0 ? rns : people.careTeam.map((m) => m.uid);
  }
  const out = mode === 'assignee_admins' ? [...primary, ...people.admins] : primary;
  const uniq = [...new Set(out.filter(Boolean))];
  return uniq.length > 0 ? uniq.sort() : [...new Set(people.admins)].sort();
}

/** The digest runs for every mode except `off`. */
export function digestEnabled(mode: MissedVisitMode): boolean {
  return mode !== 'off';
}

// ---------------------------------------------------------------------------
// v3 (V4): who may act on a visit
// ---------------------------------------------------------------------------

export interface VisitActor {
  uid: string;
  role: string;
  discipline: string;
  capabilities?: readonly string[] | null;
}

export function holdsCapability(actor: Pick<VisitActor, 'role' | 'capabilities'>, cap: string): boolean {
  return actor.role === 'admin' || (actor.capabilities ?? []).includes(cap);
}

/**
 * Update / cancel / reassign / complete a visit: admins, `scheduling` holders, the patient's
 * care team, the assignee, or the member who created the visit.
 */
export function canManageVisit(
  actor: VisitActor,
  visit: { assignedUid: string | null; createdBy: string },
  careTeamUids: readonly string[] | null | undefined,
): boolean {
  if (holdsCapability(actor, 'scheduling')) return true;
  if ((careTeamUids ?? []).includes(actor.uid)) return true;
  return visit.assignedUid === actor.uid || visit.createdBy === actor.uid;
}
