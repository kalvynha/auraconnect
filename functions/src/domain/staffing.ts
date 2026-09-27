/**
 * Care-team and offboarding rules (L1). Pure module: no Firebase imports.
 */
import type { Discipline } from '../shared/types';

/** Largest care team `updateCareTeam` accepts. */
export const MAX_CARE_TEAM = 50;

/** `current` minus `remove`, plus `add` (order kept, no duplicates). */
export function mergeCareTeam(current: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const rm = new Set(remove);
  const out: string[] = [];
  for (const u of [...current, ...add]) {
    if (!u || (rm.has(u) && !add.includes(u)) || out.includes(u)) continue;
    out.push(u);
  }
  return out;
}

export interface CareTeamDiff {
  added: string[];
  removed: string[];
}

export function careTeamDiff(before: readonly string[], after: readonly string[]): CareTeamDiff {
  return { added: after.filter((u) => !before.includes(u)), removed: before.filter((u) => !after.includes(u)) };
}

export interface ReassignTo {
  default?: string | null;
  byDiscipline?: Partial<Record<Discipline, string>>;
}

/**
 * Replacement for work of `discipline`: `byDiscipline[discipline]`, else `default`, else null.
 * Never returns the member being offboarded.
 */
export function pickReplacement(reassignTo: ReassignTo, discipline: Discipline | null | undefined, offboardUid: string): string | null {
  const byD = discipline ? reassignTo.byDiscipline?.[discipline] : undefined;
  const pick = byD || reassignTo.default || null;
  return pick && pick !== offboardUid ? pick : null;
}

/** Every replacement uid named in `reassignTo` (to validate they are active members). */
export function replacementUids(reassignTo: ReassignTo): string[] {
  return [...new Set([reassignTo.default ?? null, ...Object.values(reassignTo.byDiscipline ?? {})].filter((u): u is string => !!u))];
}
