import { describe, expect, it } from 'vitest';
import { decideEscalation, firstCheckMinutes, initialRecipients, nextStep, resolveTargets } from '../../src/domain/escalation';
import type { Alert, EscalationPolicy } from '../../src/shared/types';

const policy: EscalationPolicy = {
  name: 'P',
  steps: [
    { target: { kind: 'original' }, waitMinutes: 5 },
    { target: { kind: 'role', roleKey: 'oncall-rn' }, waitMinutes: 10 },
    { target: { kind: 'uid', uid: 'boss' }, waitMinutes: 15 },
  ],
};

const ts = { seconds: 0, nanoseconds: 0 };
function alert(over: Partial<Alert> = {}): Alert {
  return {
    title: 't', body: '', priority: 'urgent', source: { type: 'manual', patientId: null },
    targetUids: ['a', 'b'], currentTargetUids: ['a', 'b'], policyId: 'p', level: 0, exhausted: false,
    status: 'open', createdBy: 'x', createdAt: ts, ackedBy: null, ackedAt: null,
    history: [{ level: 0, targetUids: ['a', 'b'], at: ts }], ...over,
  };
}

describe('nextStep', () => {
  it('returns the following step or null', () => {
    expect(nextStep(policy, 0)).toMatchObject({ level: 1, isLast: false });
    expect(nextStep(policy, 1)).toMatchObject({ level: 2, isLast: true });
    expect(nextStep(policy, 2)).toBeNull();
    expect(nextStep(null, 0)).toBeNull();
    expect(nextStep({ name: 'x', steps: [] }, 0)).toBeNull();
  });
});

describe('firstCheckMinutes / initialRecipients', () => {
  it('schedules steps[0].waitMinutes whenever a policy has steps', () => {
    expect(firstCheckMinutes(policy)).toBe(5);
    expect(firstCheckMinutes({ name: 'one', steps: [policy.steps[0]!] })).toBe(5);
    expect(firstCheckMinutes(null)).toBeNull();
    expect(firstCheckMinutes({ name: 'empty', steps: [] })).toBeNull();
  });
  it('level 0 notifies explicit targets plus step 0 target', () => {
    expect(initialRecipients(['b', 'a'], policy, () => [])).toEqual(['a', 'b']);
    const rolePolicy: EscalationPolicy = { name: 'r', steps: [{ target: { kind: 'role', roleKey: 'k' }, waitMinutes: 1 }] };
    expect(initialRecipients(['a'], rolePolicy, () => ['rn'])).toEqual(['a', 'rn']);
    expect(initialRecipients(['a'], null, () => ['rn'])).toEqual(['a']);
  });
});

describe('resolveTargets', () => {
  const ctx = { originalUids: ['b', 'a', 'a'], resolveRole: (k: string) => (k === 'r' ? ['z', 'y'] : []) };
  it('resolves each target kind', () => {
    expect(resolveTargets({ kind: 'original' }, ctx)).toEqual(['a', 'b']);
    expect(resolveTargets({ kind: 'uid', uid: 'q' }, ctx)).toEqual(['q']);
    expect(resolveTargets({ kind: 'role', roleKey: 'r' }, ctx)).toEqual(['y', 'z']);
  });
});

describe('decideEscalation', () => {
  const ctx = { resolveRole: () => ['rn1'] };
  it('advances level 0 → 1 and schedules steps[1].waitMinutes', () => {
    expect(decideEscalation(alert(), policy, 0, ctx)).toEqual({
      action: 'advance', level: 1, currentTargetUids: ['rn1'], targetUids: ['a', 'b', 'rn1'], nextCheckMinutes: 10,
    });
  });
  it('notifies the last step and still waits its waitMinutes', () => {
    const d = decideEscalation(alert({ level: 1, targetUids: ['a', 'b', 'rn1'] }), policy, 1, ctx);
    expect(d).toEqual({ action: 'advance', level: 2, currentTargetUids: ['boss'], targetUids: ['a', 'b', 'boss', 'rn1'], nextCheckMinutes: 15 });
  });
  it('marks exhausted when the last step wait elapses unacked', () => {
    expect(decideEscalation(alert({ level: 2 }), policy, 2, ctx)).toEqual({ action: 'exhaust', level: 2 });
    expect(decideEscalation(alert(), { name: 'one', steps: [policy.steps[0]!] }, 0, ctx)).toEqual({ action: 'exhaust', level: 0 });
  });
  it('is a no-op when acked/resolved, stale, already exhausted, or without policy', () => {
    expect(decideEscalation(alert({ status: 'acked' }), policy, 0, ctx)).toEqual({ action: 'noop', reason: 'not_open' });
    expect(decideEscalation(alert({ status: 'resolved' }), policy, 0, ctx)).toMatchObject({ action: 'noop' });
    expect(decideEscalation(alert({ level: 1 }), policy, 0, ctx)).toEqual({ action: 'noop', reason: 'level_mismatch' });
    expect(decideEscalation(alert({ level: 2, exhausted: true }), policy, 2, ctx)).toEqual({ action: 'noop', reason: 'exhausted' });
    expect(decideEscalation(alert(), null, 0, ctx)).toEqual({ action: 'noop', reason: 'no_policy' });
  });
  it('falls back to original recipients when a role resolves to nobody', () => {
    const d = decideEscalation(alert(), policy, 0, { resolveRole: () => [] });
    expect(d).toMatchObject({ action: 'advance', currentTargetUids: ['a', 'b'] });
  });
});
