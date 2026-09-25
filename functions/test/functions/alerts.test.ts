import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));
vi.mock('../../src/lib/notify', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/notify')>()),
  pushToMembers: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0 })),
}));
vi.mock('../../src/lib/tasks', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/tasks')>()),
  enqueueEscalationCheck: vi.fn(async () => undefined),
}));

import { fakeDb } from '../fakes/firestore';
import { pushToMembers } from '../../src/lib/notify';
import { enqueueEscalationCheck } from '../../src/lib/tasks';
import { raiseAlert } from '../../src/alerts/raiseAlert';
import { handleAlertCreated } from '../../src/alerts/onAlertCreated';
import { handleEscalation } from '../../src/alerts/escalateAlert';
import { alertActionHandler } from '../../src/alerts/alertActions';
import { createAlertHandler } from '../../src/alerts/createAlert';
import type { Alert } from '../../src/shared/types';
import { docsIn, ORG, req, seedOrg } from './helpers';

const alertPath = (id: string) => `orgs/${ORG}/alerts/${id}`;

async function newAlert(): Promise<string> {
  const { alertId } = await raiseAlert({
    orgId: ORG,
    title: 'Urgent alert',
    body: '',
    priority: 'urgent',
    source: { type: 'manual', patientId: null },
    targetUids: ['b', 'c'],
    policyId: 'default',
    createdBy: 'b',
  });
  return alertId;
}

beforeEach(() => {
  seedOrg();
  vi.mocked(pushToMembers).mockClear();
  vi.mocked(enqueueEscalationCheck).mockClear();
});

describe('onAlertCreated', () => {
  it('pushes to level-0 recipients and enqueues the first check after steps[0].waitMinutes', async () => {
    const id = await newAlert();
    await handleAlertCreated(ORG, id, fakeDb.read<Alert>(alertPath(id))!);
    expect(pushToMembers).toHaveBeenCalledWith(ORG, ['b', 'c'], 'Urgent alert', { type: 'alert', orgId: ORG, alertId: id, priority: 'urgent' });
    expect(enqueueEscalationCheck).toHaveBeenCalledWith({ orgId: ORG, alertId: id, expectedLevel: 0 }, 600);
  });
});

describe('escalateAlert', () => {
  it('is a no-op when the alert was acked', async () => {
    const id = await newAlert();
    await alertActionHandler(req({ orgId: ORG, alertId: id }, { uid: 'c' }), 'ack');
    const before = structuredClone(fakeDb.read<any>(alertPath(id)));
    const d = await handleEscalation({ orgId: ORG, alertId: id, expectedLevel: 0 });
    expect(d).toEqual({ action: 'noop', reason: 'not_open' });
    expect(fakeDb.read<any>(alertPath(id)).level).toBe(before.level);
    expect(pushToMembers).not.toHaveBeenCalled();
    expect(enqueueEscalationCheck).not.toHaveBeenCalled();
  });

  it('advances to the next step, notifies it, and schedules its wait; then exhausts', async () => {
    const id = await newAlert();
    const d1 = await handleEscalation({ orgId: ORG, alertId: id, expectedLevel: 0 });
    expect(d1).toMatchObject({ action: 'advance', level: 1, currentTargetUids: ['a'] });
    const a1 = fakeDb.read<any>(alertPath(id));
    expect(a1).toMatchObject({ level: 1, currentTargetUids: ['a'], targetUids: ['a', 'b', 'c'], exhausted: false });
    expect(a1.history.map((h: any) => h.level)).toEqual([0, 1]);
    expect(pushToMembers).toHaveBeenCalledWith(ORG, ['a'], 'Urgent alert', expect.objectContaining({ alertId: id }));
    expect(enqueueEscalationCheck).toHaveBeenCalledWith({ orgId: ORG, alertId: id, expectedLevel: 1 }, 900);

    // duplicate delivery of the level-0 task is ignored
    expect(await handleEscalation({ orgId: ORG, alertId: id, expectedLevel: 0 })).toEqual({ action: 'noop', reason: 'level_mismatch' });

    const d2 = await handleEscalation({ orgId: ORG, alertId: id, expectedLevel: 1 });
    expect(d2).toEqual({ action: 'exhaust', level: 1 });
    expect(fakeDb.read<any>(alertPath(id)).exhausted).toBe(true);
    expect(enqueueEscalationCheck).toHaveBeenCalledTimes(1);
    expect(docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'alert.escalate' && l.data.actorUid === 'system')).toHaveLength(2);
  });
});

describe('ackAlert / resolveAlert', () => {
  it('only targets or admins can ack; ack is idempotent; resolve sets resolved', async () => {
    const id = await newAlert();
    await expect(alertActionHandler(req({ orgId: ORG, alertId: id }, { uid: 'v', role: 'viewer' }), 'ack')).rejects.toMatchObject({ code: 'permission-denied' });
    await alertActionHandler(req({ orgId: ORG, alertId: id }, { uid: 'b' }), 'ack');
    await alertActionHandler(req({ orgId: ORG, alertId: id }, { uid: 'c' }), 'ack');
    expect(fakeDb.read<any>(alertPath(id))).toMatchObject({ status: 'acked', ackedBy: 'b' });
    await alertActionHandler(req({ orgId: ORG, alertId: id }, { uid: 'a', role: 'admin' }), 'resolve');
    expect(fakeDb.read<any>(alertPath(id))).toMatchObject({ status: 'resolved', ackedBy: 'b' });
    await expect(alertActionHandler(req({ orgId: ORG, alertId: id }, { uid: 'b' }), 'ack')).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('createAlert', () => {
  it('creates a manual alert for active members using the org default policy', async () => {
    const { alertId } = await createAlertHandler(req({ orgId: ORG, title: 'Check on bed 2', body: '', priority: 'critical', targetUids: ['c'] }, { uid: 'b' }));
    expect(fakeDb.read<any>(alertPath(alertId))).toMatchObject({ targetUids: ['c'], policyId: 'pol', source: { type: 'manual', patientId: null } });
  });
  it('rejects inactive targets and viewers', async () => {
    await expect(createAlertHandler(req({ orgId: ORG, title: 't', priority: 'urgent', targetUids: ['x'] } as any, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(createAlertHandler(req({ orgId: ORG, title: 't', priority: 'urgent', targetUids: ['c'] } as any, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
