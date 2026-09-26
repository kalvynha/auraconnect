/**
 * Task templates instantiated on patient lifecycle events. Pure module: no Firebase imports.
 *
 * Defaults follow docs/DATA_MODEL.md ("Task templates"). An org may override a
 * template per event (`taskTemplates/{event}`); when it has none, these apply.
 * A templated task goes to the care-team member with the matching discipline
 * (first match in care-team order), otherwise it stays unassigned. Its due date
 * is the event date plus `offsetDays`.
 */
import type { Discipline, ISODate, Priority, TaskTemplateEvent, TaskTemplateItem } from '../shared/types';
import { addDays } from './dates';

const item = (title: string, discipline: Discipline, offsetDays: number, priority: Priority = 'normal'): TaskTemplateItem => ({
  title,
  description: null,
  discipline,
  offsetDays,
  priority,
});

export const TASK_TEMPLATE_EVENTS: readonly TaskTemplateEvent[] = ['admission', 'recertification', 'discharge', 'death'];

export const DEFAULT_TASK_TEMPLATES: Readonly<Record<TaskTemplateEvent, readonly TaskTemplateItem[]>> = {
  admission: [
    item('Comprehensive assessment', 'RN', 5),
    item('Medication reconciliation', 'RN', 1),
    item('DME needs review', 'RN', 2),
    item('Social work assessment', 'SW', 5),
    item('Spiritual assessment', 'Chaplain', 5),
    item('Initial plan of care', 'MD', 5),
  ],
  recertification: [item('Update plan of care', 'RN', 0), item('Physician narrative', 'MD', 0)],
  discharge: [
    item('Discharge summary', 'RN', 2),
    item('Notify attending physician', 'RN', 1),
    item('Coordinate DME pickup', 'SW', 3),
  ],
  death: [
    item('Notify attending physician', 'RN', 0),
    item('Coordinate DME pickup', 'SW', 2),
    item('Medication disposal documentation', 'RN', 1),
    item('Bereavement assessment', 'SW', 7),
    item('Death summary', 'RN', 2),
  ],
};

/** Template items for `event`: the org's own items when a template doc exists, else the defaults. */
export function templateItemsFor(event: TaskTemplateEvent, orgItems: readonly TaskTemplateItem[] | null | undefined): TaskTemplateItem[] {
  const src = orgItems ?? DEFAULT_TASK_TEMPLATES[event];
  return src.map((i) => ({ ...i }));
}

export interface CareTeamMemberRef {
  uid: string;
  discipline: Discipline;
}

export interface InstantiatedTask {
  title: string;
  description: string | null;
  discipline: Discipline | null;
  assigneeUid: string | null;
  dueDate: ISODate;
  priority: Priority;
}

/**
 * Turns template items into concrete tasks for one patient event.
 * `careTeam` should be the patient's *active* care team, in care-team order.
 */
export function instantiateTemplate(
  items: readonly TaskTemplateItem[],
  eventDate: ISODate,
  careTeam: readonly CareTeamMemberRef[],
): InstantiatedTask[] {
  return items.map((i) => {
    const match = i.discipline ? careTeam.find((m) => m.discipline === i.discipline) : undefined;
    return {
      title: i.title,
      description: i.description ?? null,
      discipline: i.discipline ?? null,
      assigneeUid: match?.uid ?? null,
      dueDate: addDays(eventDate, Math.trunc(i.offsetDays)),
      priority: i.priority ?? 'normal',
    };
  });
}
