/**
 * Escalation engine semantics. Pure module: no Firebase imports.
 *
 * `alert.level` is an index into `policy.steps`. **Level i = steps[i]:
 * notify step i's target, wait `steps[i].waitMinutes`, then move to level
 * i + 1.**
 *
 *  - **Creation (level 0).** The alert notifies its initial recipients plus
 *    `steps[0].target` resolved (step 0 is usually `{ kind: 'original' }`,
 *    which *is* the initial recipients). If a policy with ≥ 1 step applies, a
 *    check is scheduled after `steps[0].waitMinutes` carrying
 *    `expectedLevel: 0`.
 *  - **Check fires (expectedLevel = L).** If the alert is not `open`, or its
 *    level is no longer L (already advanced / duplicate delivery), or it is
 *    already exhausted, nothing happens (idempotent).
 *    - If `steps[L + 1]` exists: advance to level L + 1, resolve its target,
 *      add those uids to `targetUids`, set `currentTargetUids`, append a
 *      history event, push to them, and schedule the next check after
 *      `steps[L + 1].waitMinutes` with `expectedLevel: L + 1`.
 *    - Otherwise the last step has been notified *and* its wait elapsed
 *      without an ack: mark `exhausted: true`. No one new is notified and
 *      no further check is scheduled.
 *  - An empty resolution (e.g. a role with nobody on call and no fallback)
 *    falls back to the original recipients so the step still notifies someone.
 *  - No policy (or a policy with no steps): nothing is ever scheduled and the
 *    alert stays at level 0 with `exhausted: false`.
 */
import type { Alert, EscalationPolicy, EscalationStep, EscalationTarget } from '../shared/types';
import { normalizeUids } from './channels';

export interface NextStep {
  level: number;
  step: EscalationStep;
  isLast: boolean;
}

/** The step to move to from `currentLevel`, or null when there is none (policy exhausted). */
export function nextStep(policy: EscalationPolicy | null | undefined, currentLevel: number): NextStep | null {
  if (!policy || !Array.isArray(policy.steps)) return null;
  const level = currentLevel + 1;
  if (level < 1 || level >= policy.steps.length) return null;
  const step = policy.steps[level];
  if (!step) return null;
  return { level, step, isLast: level === policy.steps.length - 1 };
}

export function hasSteps(policy: EscalationPolicy | null | undefined): policy is EscalationPolicy {
  return !!policy && Array.isArray(policy.steps) && policy.steps.length > 0;
}

/** Minutes until the first check (after level 0), or null when no policy applies. */
export function firstCheckMinutes(policy: EscalationPolicy | null | undefined): number | null {
  return hasSteps(policy) ? waitMinutesOf(policy.steps[0]) : null;
}

export function waitMinutesOf(step: EscalationStep | undefined): number {
  const w = Number(step?.waitMinutes);
  return Number.isFinite(w) && w > 0 ? w : 1;
}

export interface TargetContext {
  /** The alert's first recipients (`history[0].targetUids`). */
  originalUids: readonly string[];
  /** Pre-resolved on-call uids for a role key. */
  resolveRole: (roleKey: string) => readonly string[];
}

export function resolveTargets(target: EscalationTarget, ctx: TargetContext): string[] {
  switch (target.kind) {
    case 'original':
      return normalizeUids(ctx.originalUids);
    case 'uid':
      return normalizeUids([target.uid]);
    case 'role':
      return normalizeUids(ctx.resolveRole(target.roleKey));
    default:
      return [];
  }
}

/** Level-0 recipients: the explicit targets plus `steps[0].target` (if any). */
export function initialRecipients(
  explicitUids: readonly string[],
  policy: EscalationPolicy | null | undefined,
  resolveRole: (roleKey: string) => readonly string[],
): string[] {
  const base = normalizeUids(explicitUids);
  if (!hasSteps(policy)) return base;
  return normalizeUids([...base, ...resolveTargets(policy.steps[0]!.target, { originalUids: base, resolveRole })]);
}

/** The alert's first recipients: history[0] if present, else currentTargetUids at level 0. */
export function originalRecipients(alert: Pick<Alert, 'history' | 'currentTargetUids' | 'targetUids'>): string[] {
  const first = alert.history?.find((h) => h.level === 0);
  return normalizeUids(first?.targetUids ?? alert.currentTargetUids ?? alert.targetUids ?? []);
}

export type EscalationDecision =
  | { action: 'noop'; reason: 'not_open' | 'level_mismatch' | 'no_policy' | 'exhausted' }
  /** The last step's wait elapsed without an ack. */
  | { action: 'exhaust'; level: number }
  | {
      action: 'advance';
      level: number;
      currentTargetUids: string[];
      targetUids: string[];
      /** Minutes until the next check (`steps[level].waitMinutes`). */
      nextCheckMinutes: number;
    };

/** Decide what an escalation check for `expectedLevel` should do. */
export function decideEscalation(
  alert: Pick<Alert, 'status' | 'level' | 'exhausted' | 'targetUids' | 'currentTargetUids' | 'history'>,
  policy: EscalationPolicy | null | undefined,
  expectedLevel: number,
  ctx: Omit<TargetContext, 'originalUids'>,
): EscalationDecision {
  if (alert.status !== 'open') return { action: 'noop', reason: 'not_open' };
  if (alert.level !== expectedLevel) return { action: 'noop', reason: 'level_mismatch' };
  if (alert.exhausted) return { action: 'noop', reason: 'exhausted' };
  if (!hasSteps(policy)) return { action: 'noop', reason: 'no_policy' };
  const next = nextStep(policy, alert.level);
  if (!next) return { action: 'exhaust', level: alert.level };

  const originalUids = originalRecipients(alert);
  let targets = resolveTargets(next.step.target, { originalUids, resolveRole: ctx.resolveRole });
  if (targets.length === 0) targets = originalUids;

  return {
    action: 'advance',
    level: next.level,
    currentTargetUids: targets,
    targetUids: normalizeUids([...(alert.targetUids ?? []), ...targets]),
    nextCheckMinutes: waitMinutesOf(next.step),
  };
}

/** Default policy created with every org: re-notify the original recipients at +10 min, exhausted at +25 min. */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  name: 'Standard',
  steps: [
    { target: { kind: 'original' }, waitMinutes: 10 },
    { target: { kind: 'original' }, waitMinutes: 15 },
  ],
};
