import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_TEMPLATES, instantiateTemplate, templateItemsFor } from '../../src/domain/taskTemplates';

describe('DEFAULT_TASK_TEMPLATES', () => {
  it('matches the DATA_MODEL table', () => {
    const summary = (e: keyof typeof DEFAULT_TASK_TEMPLATES) => DEFAULT_TASK_TEMPLATES[e].map((i) => `${i.title}|${i.discipline}|${i.offsetDays}`);
    expect(summary('admission')).toEqual([
      'Comprehensive assessment|RN|5', 'Medication reconciliation|RN|1', 'DME needs review|RN|2',
      'Social work assessment|SW|5', 'Spiritual assessment|Chaplain|5', 'Initial plan of care|MD|5',
    ]);
    expect(summary('recertification')).toEqual(['Update plan of care|RN|0', 'Physician narrative|MD|0']);
    expect(summary('discharge')).toEqual(['Discharge summary|RN|2', 'Notify attending physician|RN|1', 'Coordinate DME pickup|SW|3']);
    expect(summary('death')).toEqual([
      'Notify attending physician|RN|0', 'Coordinate DME pickup|SW|2', 'Medication disposal documentation|RN|1',
      'Bereavement assessment|SW|7', 'Death summary|RN|2',
    ]);
  });

  it('uses org items when present (even an empty list), defaults otherwise', () => {
    expect(templateItemsFor('discharge', null)).toHaveLength(3);
    expect(templateItemsFor('discharge', [])).toEqual([]);
    const custom = [{ title: 'X', description: null, discipline: null, offsetDays: 0, priority: 'urgent' as const }];
    expect(templateItemsFor('discharge', custom)).toEqual(custom);
  });
});

describe('instantiateTemplate', () => {
  it('assigns the first care-team member of the matching discipline and offsets due dates', () => {
    const tasks = instantiateTemplate(DEFAULT_TASK_TEMPLATES.admission, '2026-01-30', [
      { uid: 'sw1', discipline: 'SW' },
      { uid: 'rn1', discipline: 'RN' },
      { uid: 'rn2', discipline: 'RN' },
    ]);
    expect(tasks.map((t) => [t.title, t.assigneeUid, t.dueDate])).toEqual([
      ['Comprehensive assessment', 'rn1', '2026-02-04'],
      ['Medication reconciliation', 'rn1', '2026-01-31'],
      ['DME needs review', 'rn1', '2026-02-01'],
      ['Social work assessment', 'sw1', '2026-02-04'],
      ['Spiritual assessment', null, '2026-02-04'],
      ['Initial plan of care', null, '2026-02-04'],
    ]);
    expect(tasks.every((t) => t.priority === 'normal')).toBe(true);
    expect(tasks[4]!.discipline).toBe('Chaplain');
  });

  it('leaves discipline-less items unassigned', () => {
    const [t] = instantiateTemplate([{ title: 'Call family', description: 'd', discipline: null, offsetDays: 0, priority: 'urgent' }], '2026-03-01', [{ uid: 'a', discipline: 'RN' }]);
    expect(t).toEqual({ title: 'Call family', description: 'd', discipline: null, assigneeUid: null, dueDate: '2026-03-01', priority: 'urgent' });
  });
});
