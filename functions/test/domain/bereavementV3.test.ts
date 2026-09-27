import { describe, expect, it } from 'vitest';
import {
  autoCloseDecision,
  buildBereavementSchedule,
  buildMailingRows,
  canWorkBereavementPlan,
  contactsByPlan,
  highRiskAdditions,
  mailingSurvivors,
  pendingContact,
  planSurvivors,
  primaryContactFrom,
  survivorFromCaregiver,
  type MailingPlan,
} from '../../src/domain/bereavement';
import { activeVolunteerUids, affectedPatientIds } from '../../src/volunteers/volunteerUids';
import { complianceRatio, monthSegments, summarize, visitMinutes } from '../../src/volunteers/compliance';
import type { BereavementSurvivor } from '../../src/shared/types';

const ADDR = { line1: '1 Main St', line2: null, city: 'Springfield', state: 'IL', zip: '62701' };
const survivor = (over: Partial<BereavementSurvivor>): BereavementSurvivor => ({
  id: 's1', name: 'Ann', relationship: 'daughter', phone: '555', email: null, address: ADDR,
  preferredContact: 'mail', doNotContact: false, isPrimary: false, ...over,
});

describe('high-risk schedule', () => {
  it('adds an SW visit at 2 weeks and monthly calls for 3 months, sorted by due date', () => {
    const s = buildBereavementSchedule('2026-01-31', 'high');
    expect(s).toHaveLength(15);
    expect(s.map((c) => c.id).slice(0, 6)).toEqual(['d3-call', 'd7-letter', 'hr-d14-visit', 'm1-letter', 'm1-assessment', 'hr-m1-call']);
    expect(s.find((c) => c.id === 'hr-d14-visit')).toMatchObject({ type: 'visit', dueDate: '2026-02-14' });
    expect(s.filter((c) => c.id.startsWith('hr-m')).map((c) => c.dueDate)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    const dates = s.map((c) => c.dueDate);
    expect([...dates].sort()).toEqual(dates);
    expect(buildBereavementSchedule('2026-01-31', 'moderate')).toHaveLength(11);
  });

  it('reassessment to high adds only missing contacts, moving past-due ones to today', () => {
    const add = highRiskAdditions('2026-01-01', 'high', ['d3-call', 'hr-m1-call'], '2026-02-10');
    expect(add.map((c) => [c.id, c.dueDate])).toEqual([
      ['hr-d14-visit', '2026-02-10'], // natural due 01-15 is past
      ['hr-m2-call', '2026-03-01'],
      ['hr-m3-call', '2026-04-01'],
    ]);
    expect(highRiskAdditions('2026-01-01', 'moderate', [], '2026-02-10')).toEqual([]);
    expect(pendingContact(add[0]!)).toMatchObject({ status: 'pending', completedAt: null, completedBy: null, note: null });
  });
});

describe('survivors', () => {
  it('seeds the primary survivor from the caregiver, preferring mail when an address is known', () => {
    expect(survivorFromCaregiver(null)).toBeNull();
    expect(survivorFromCaregiver({ name: 'John', relationship: 'son', phone: '555' })).toMatchObject({
      id: 'primary', name: 'John', preferredContact: 'phone', isPrimary: true, doNotContact: false,
      address: { line1: null, city: null },
    });
    expect(survivorFromCaregiver({ name: 'J', relationship: null, phone: null, email: 'j@x.org' })!.preferredContact).toBe('email');
    expect(survivorFromCaregiver({ name: 'J', relationship: null, phone: null, address: ADDR })!.preferredContact).toBe('mail');
  });

  it('falls back to primaryContact for pre-v3 plans and mirrors the primary survivor back', () => {
    expect(planSurvivors({ primaryContact: { name: 'John', relationship: 'son', phone: '1' } })).toHaveLength(1);
    expect(planSurvivors({ survivors: [], primaryContact: { name: 'John', relationship: 'son', phone: '1' } })).toEqual([]);
    const list = [survivor({ id: 'a', name: 'A' }), survivor({ id: 'b', name: 'B', isPrimary: true, email: 'b@x.org' })];
    expect(primaryContactFrom(list)).toMatchObject({ name: 'B', email: 'b@x.org' });
    expect(primaryContactFrom([])).toBeNull();
  });

  it('mails only survivors who accept mail/email and are not do-not-contact', () => {
    const list = [
      survivor({ id: 'a' }),
      survivor({ id: 'b', preferredContact: 'phone' }),
      survivor({ id: 'c', doNotContact: true }),
      survivor({ id: 'd', preferredContact: 'email', email: 'd@x.org' }),
    ];
    expect(mailingSurvivors(list).map((s) => s.id)).toEqual(['a', 'd']);
  });
});

describe('buildMailingRows', () => {
  const contacts = buildBereavementSchedule('2026-01-01').map(pendingContact);
  const plan = (id: string, over: Partial<MailingPlan> = {}): MailingPlan => ({
    id, patientName: `Doe ${id}`, status: 'active', contacts, primaryContact: null,
    survivors: [survivor({ id: 'a', name: 'Ann' }), survivor({ id: 'b', name: 'Bob', preferredContact: 'phone' })],
    ...over,
  });

  it('one row per pending letter in range per mailing survivor', () => {
    const rows = buildMailingRows(
      [
        plan('p1'),
        plan('p2', { contacts: contacts.map((c) => (c.id === 'm1-letter' ? { ...c, status: 'done' as const } : c)) }),
        plan('p3', { survivors: [survivor({ id: 'x', doNotContact: true })] }),
        plan('p4', { status: 'closed' }),
      ],
      '2026-01-05',
      '2026-02-01',
      ['letter'],
    );
    // d7-letter (01-08) and m1-letter (02-01) for p1; only d7 for p2; none for p3/p4.
    expect(rows.map((r) => [r.planId, r.contactId, r.survivorName])).toEqual([
      ['p1', 'd7-letter', 'Ann'],
      ['p2', 'd7-letter', 'Ann'],
      ['p1', 'm1-letter', 'Ann'],
    ]);
    expect(rows[0]).toMatchObject({ address: ADDR, preferredContact: 'mail', contactType: 'letter', patientName: 'Doe p1' });
    expect([...contactsByPlan(rows).entries()]).toEqual([['p1', ['d7-letter', 'm1-letter']], ['p2', ['d7-letter']]]);
  });

  it('uses the legacy primaryContact only when it prefers mail (it has no address → phone → no rows)', () => {
    expect(buildMailingRows([plan('p1', { survivors: undefined, primaryContact: { name: 'Jo', relationship: null, phone: '1' } })], '2026-01-01', '2026-12-31', ['letter'])).toEqual([]);
  });
});

describe('autoCloseDecision', () => {
  const base = { status: 'active' as const, closesOn: '2027-02-01', contacts: [pendingContact({ id: 'a', type: 'call' as const, label: 'x', dueDate: '2026-02-01' })] };
  it('closes an expired plan with every contact handled, flags it otherwise', () => {
    expect(autoCloseDecision(base, '2027-02-01')).toBe('none'); // closesOn == today: not yet
    expect(autoCloseDecision(base, '2027-02-02')).toBe('review');
    expect(autoCloseDecision({ ...base, contacts: [{ ...base.contacts[0]!, status: 'skipped' }] }, '2027-02-02')).toBe('close');
    expect(autoCloseDecision({ ...base, status: 'closed' }, '2027-03-01')).toBe('none');
  });
});

describe('canWorkBereavementPlan (H4)', () => {
  const m = (over: object) => ({ role: 'clinician' as const, discipline: 'RN' as const, capabilities: [], ...over });
  it('allows the capability, SW/Chaplain, admins and the plan coordinator only', () => {
    expect(canWorkBereavementPlan(m({}), 'u1', { assignedUid: null })).toBe(false);
    expect(canWorkBereavementPlan(m({}), 'u1', { assignedUid: 'u1' })).toBe(true);
    expect(canWorkBereavementPlan(m({ capabilities: ['bereavement'] }), 'u1', { assignedUid: null })).toBe(true);
    expect(canWorkBereavementPlan(m({ discipline: 'SW' }), 'u1', { assignedUid: 'x' })).toBe(true);
    expect(canWorkBereavementPlan(m({ discipline: 'Chaplain' }), 'u1', { assignedUid: 'x' })).toBe(true);
    expect(canWorkBereavementPlan(m({ role: 'admin' }), 'u1', { assignedUid: 'x' })).toBe(true);
    expect(canWorkBereavementPlan(m({ capabilities: ['volunteers'] }), 'u1', { assignedUid: 'x' })).toBe(false);
  });
});

describe('volunteer helpers', () => {
  it('activeVolunteerUids: active only, unique, sorted', () => {
    expect(activeVolunteerUids([
      { volunteerUid: 'b', status: 'active' },
      { volunteerUid: 'a', status: 'active' },
      { volunteerUid: 'b', status: 'active' },
      { volunteerUid: 'c', status: 'ended' },
    ])).toEqual(['a', 'b']);
  });

  it('affectedPatientIds covers patient moves and deletes', () => {
    expect(affectedPatientIds({ patientId: 'p1' }, { patientId: 'p2' })).toEqual(['p1', 'p2']);
    expect(affectedPatientIds({ patientId: 'p1' }, null)).toEqual(['p1']);
    expect(affectedPatientIds(null, { patientId: 'p1' })).toEqual(['p1']);
  });

  it('monthSegments splits a range by calendar month with day fractions', () => {
    expect(monthSegments('2026-01-16', '2026-03-10')).toEqual([
      { month: '2026-01', from: '2026-01-16', to: '2026-01-31', fraction: 16 / 31 },
      { month: '2026-02', from: '2026-02-01', to: '2026-02-28', fraction: 1 },
      { month: '2026-03', from: '2026-03-01', to: '2026-03-10', fraction: 10 / 31 },
    ]);
    expect(monthSegments('2026-05-01', '2026-05-01')).toHaveLength(1);
  });

  it('visitMinutes, ratio and summary', () => {
    expect(visitMinutes(0, 45 * 60_000)).toBe(45);
    expect(visitMinutes(10, 5)).toBe(0);
    expect(visitMinutes(0, 48 * 3_600_000)).toBe(1440);
    expect(complianceRatio(30, 0)).toBeNull();
    expect(summarize([
      { month: '2026-01', volunteerMinutes: 50, staffMinutes: 1000, staffSource: 'visits' },
      { month: '2026-02', volunteerMinutes: 10, staffMinutes: 1000, staffSource: 'override' },
    ])).toEqual({ volunteerMinutes: 60, staffMinutes: 2000, ratio: 0.03, target: 0.05, meetsTarget: false });
  });
});
