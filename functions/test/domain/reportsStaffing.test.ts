import { describe, expect, it } from 'vitest';
import { censusSummary, complianceRows, onCensus, type CensusPatient } from '../../src/domain/reports';
import { careTeamDiff, mergeCareTeam, pickReplacement, replacementUids } from '../../src/domain/staffing';
import { canManageVisit, missedVisitRecipients } from '../../src/domain/visits';
import { computeMilestones } from '../../src/domain/milestones';
import type { MilestoneKind } from '../../src/shared/types';

describe('complianceRows', () => {
  const milestones = computeMilestones('2026-09-01', 1);
  const base = { patientId: 'p1', patientName: 'Doe, Jane', mrn: 'M1', milestones, endDate: null };
  const all = new Set<MilestoneKind>(['noe', 'hope_admission', 'hope_huv1', 'hope_huv2', 'recert', 'f2f']);

  it('classifies on time, late (effectiveDate wins over completedAt), overdue and open', () => {
    const rows = complianceRows(
      {
        ...base,
        completions: {
          'noe:2026-09-06': { effectiveDate: '2026-09-04', completedDate: '2026-09-09', completedBy: 'u1' },
          'hope_admission:2026-09-05': { effectiveDate: null, completedDate: '2026-09-07', completedBy: 'u2' },
        },
      },
      '2026-09-01',
      '2026-09-30',
      all,
      '2026-09-20',
    );
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(by.noe).toMatchObject({ status: 'on_time', effectiveDate: '2026-09-04', daysLate: 0, completedBy: 'u1', mrn: 'M1' });
    expect(by.hope_admission).toMatchObject({ status: 'late', effectiveDate: '2026-09-07', daysLate: 2 });
    expect(by.hope_huv1).toMatchObject({ status: 'overdue', due: '2026-09-15', daysLate: 5, effectiveDate: null });
    expect(by.hope_huv2).toMatchObject({ status: 'open', due: '2026-09-30', daysLate: 0 });
    expect(by.recert).toBeUndefined(); // period 1 ends 2026-11-29, outside the range
  });

  it('filters kinds and drops unfiled milestones due after the end of care', () => {
    const rows = complianceRows({ ...base, completions: {}, endDate: '2026-09-10' }, '2026-09-01', '2026-12-31', new Set<MilestoneKind>(['noe', 'hope_huv1', 'recert']), '2026-12-31');
    expect(rows.map((r) => r.kind)).toEqual(['noe']);
  });
});

describe('censusSummary', () => {
  const p = (id: string, admissionDate: string | null, endDate: string | null = null, endReason: CensusPatient['endReason'] = null): CensusPatient => ({
    patientId: id, patientName: id, mrn: null, status: endReason === 'death' ? 'deceased' : endDate ? 'discharged' : 'admitted', levelOfCare: 'routine', admissionDate, endDate, endReason,
  });

  it('counts census days, admissions, discharges by reason and deaths', () => {
    const patients = [
      p('a', '2026-08-01'), // on census all 10 days
      p('b', '2026-09-05'), // admitted in range: 6 days (5..10)
      p('c', '2026-08-01', '2026-09-03', 'death'), // days 1, 2
      p('d', '2026-08-01', '2026-09-08', 'revocation'), // days 1..7
      p('e', '2026-07-01', '2026-08-15', 'transfer'), // before range: excluded
      p('f', '2026-09-20'), // after range: excluded
    ];
    const s = censusSummary(patients, '2026-09-01', '2026-09-10');
    expect(s.roster.map((r) => [r.patientId, r.daysInRange])).toEqual([['a', 10], ['b', 6], ['c', 2], ['d', 7]]);
    expect(s).toMatchObject({ admissions: 1, discharges: 1, deaths: 1, dischargesByReason: { revocation: 1 }, censusAtStart: 3, censusAtEnd: 2, averageDailyCensus: 2.5 });
    expect(onCensus(p('x', '2026-09-01', '2026-09-01', 'death'), '2026-09-01')).toBe(false);
  });
});

describe('staffing helpers', () => {
  it('mergeCareTeam / careTeamDiff', () => {
    expect(mergeCareTeam(['a', 'b'], ['c', 'a'], ['b'])).toEqual(['a', 'c']);
    expect(careTeamDiff(['a', 'b'], ['a', 'c'])).toEqual({ added: ['c'], removed: ['b'] });
  });

  it('pickReplacement prefers the discipline mapping, then the default, never the offboarded member', () => {
    const to = { default: 'd1', byDiscipline: { SW: 's1', RN: 'x' } };
    expect(pickReplacement(to, 'SW', 'x')).toBe('s1');
    expect(pickReplacement(to, 'Chaplain', 'x')).toBe('d1');
    expect(pickReplacement(to, 'RN', 'x')).toBeNull();
    expect(pickReplacement({}, 'RN', 'x')).toBeNull();
    expect(replacementUids(to).sort()).toEqual(['d1', 's1', 'x']);
  });
});

describe('missed-visit recipients and visit permissions', () => {
  const careTeam = [{ uid: 'sw', discipline: 'SW' }, { uid: 'rn', discipline: 'RN' }];
  it('routes by mode', () => {
    expect(missedVisitRecipients('assignee', { assignee: 'aide', careTeam, admins: ['adm'] })).toEqual(['aide']);
    expect(missedVisitRecipients('assignee', { assignee: null, careTeam, admins: ['adm'] })).toEqual(['rn']);
    expect(missedVisitRecipients('assignee', { assignee: null, careTeam: [careTeam[0]!], admins: ['adm'] })).toEqual(['sw']);
    expect(missedVisitRecipients('assignee', { assignee: null, careTeam: [], admins: ['adm'] })).toEqual(['adm']);
    expect(missedVisitRecipients('assignee_admins', { assignee: 'aide', careTeam, admins: ['adm'] })).toEqual(['adm', 'aide']);
    expect(missedVisitRecipients('digest', { assignee: 'aide', careTeam, admins: ['adm'] })).toEqual([]);
    expect(missedVisitRecipients('off', { assignee: 'aide', careTeam, admins: ['adm'] })).toEqual([]);
  });

  it('canManageVisit: scheduling, care team, assignee or creator', () => {
    const v = { assignedUid: 'as', createdBy: 'cr' };
    const actor = (uid: string, extra: Record<string, unknown> = {}) => ({ uid, role: 'clinician', discipline: 'RN', ...extra });
    expect(canManageVisit(actor('as'), v, [])).toBe(true);
    expect(canManageVisit(actor('cr'), v, [])).toBe(true);
    expect(canManageVisit(actor('ct'), v, ['ct'])).toBe(true);
    expect(canManageVisit(actor('sch', { capabilities: ['scheduling'] }), v, [])).toBe(true);
    expect(canManageVisit(actor('adm', { role: 'admin' }), v, [])).toBe(true);
    expect(canManageVisit(actor('other', { capabilities: ['reports'] }), v, [])).toBe(false);
  });
});
