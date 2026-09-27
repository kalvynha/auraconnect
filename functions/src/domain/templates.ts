/**
 * v4 message templates. Pure module: no Firebase imports.
 *
 * The default org template set is seeded by `createOrg` and `seedDefaultTemplates`. Every default is
 * PHI-free: patient details only ever appear as placeholders that the client fills locally from the
 * channel context (see `BUILTIN_PLACEHOLDERS`) or from the template's form `fields`.
 */
import { DEFAULT_QUICK_REPLIES, type MessageTemplate, type TemplateField } from '../shared/types';

/** Placeholders clients fill from channel context (documented on `MessageTemplate`). */
export const BUILTIN_PLACEHOLDERS: readonly string[] = [
  'patient', 'patientFirst', 'codeStatus', 'caregiver', 'caregiverPhone', 'me', 'myDiscipline', 'time', 'date',
];

/** A template as stored, minus the server-stamped `createdBy` / `updatedAt`. */
export type TemplateContent = Omit<MessageTemplate, 'createdBy' | 'updatedAt'>;

export interface DefaultTemplate {
  /** Document id under `messageTemplates` (stable, so seeding is idempotent). */
  id: string;
  template: TemplateContent;
}

/** Template doc ids: letters, digits, `_` and `-` (also what the `[[tpl:id]]` marker accepts). */
export const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Field keys used as `{{key}}` placeholders. */
export const TEMPLATE_FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

const MARKER_RE = /^\s*\[\[tpl:([A-Za-z0-9_-]{1,128})\]\][ \t]*(?:\r?\n)?/;
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Strips a leading `[[tpl:{id}]]` marker. Returns the body without it and the template id, or the
 * body unchanged and `templateId: null` when there is no (well-formed) marker.
 */
export function stripTemplateMarker(body: string): { body: string; templateId: string | null } {
  const m = MARKER_RE.exec(body ?? '');
  if (!m) return { body: body ?? '', templateId: null };
  return { body: body.slice(m[0].length), templateId: m[1]! };
}

/** Distinct `{{key}}` placeholders in a template body, in order of first use. */
export function templatePlaceholders(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Placeholders that are neither built in nor one of the template's field keys. */
export function unknownPlaceholders(t: Pick<TemplateContent, 'body' | 'fields'>): string[] {
  const keys = new Set([...BUILTIN_PLACEHOLDERS, ...t.fields.map((f) => f.key)]);
  return templatePlaceholders(t.body).filter((k) => !keys.has(k));
}

/** Fills `{{key}}` placeholders from `values`; unknown keys are left as they are. (Used by tests and previews.) */
export function fillTemplate(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(PLACEHOLDER_RE, (whole, key: string) => (key in values ? values[key]! : whole));
}

// ---------------------------------------------------------------------------
// Default template set
// ---------------------------------------------------------------------------

const text = (key: string, label: string, required = true): TemplateField => ({ key, label, kind: 'text', required });
const multi = (key: string, label: string, required = true): TemplateField => ({ key, label, kind: 'multiline', required });
const num = (key: string, label: string, required = true): TemplateField => ({ key, label, kind: 'number', required });
const choice = (key: string, label: string, options: string[], required = true): TemplateField => ({
  key, label, kind: 'choice', options, required,
});

function tpl(p: Omit<TemplateContent, 'active'> & { active?: boolean }): TemplateContent {
  return { ...p, active: p.active ?? true };
}

const YES_NO = ['Yes', 'No'];
const YES_NO_UNKNOWN = ['Yes', 'No', 'Unknown'];

const CORE: DefaultTemplate[] = [
  {
    id: 'default-sbar',
    template: tpl({
      title: 'SBAR – MD/NP escalation',
      category: 'escalation',
      body: [
        'SBAR for {{patient}} (code status: {{codeStatus}})',
        'S – Situation: {{S}}',
        'B – Background: {{B}}',
        'A – Assessment: {{A}}',
        'R – Recommendation/request: {{R}}',
        'Please call back at your earliest opportunity. – {{me}}, {{myDiscipline}}',
      ].join('\n'),
      fields: [
        multi('S', 'Situation – what is happening right now'),
        multi('B', 'Background – diagnosis, recent changes, meds already tried'),
        multi('A', 'Assessment – vitals, symptom scores, your clinical impression'),
        multi('R', 'Recommendation – what you need (new order, visit, call back)'),
      ],
      defaultPriority: 'urgent',
      patientContext: true,
      order: 10,
    }),
  },
  {
    id: 'default-symptom-crisis',
    template: tpl({
      title: 'Symptom crisis (pain or dyspnea)',
      category: 'escalation',
      body: [
        'Symptom crisis for {{patient}}',
        'Symptom: {{symptom}} – severity {{severity}}/10',
        'Interventions tried and response: {{interventions}}',
        'Request: {{request}}',
        'Code status: {{codeStatus}}. Reported by {{me}}, {{myDiscipline}} at {{time}}.',
      ].join('\n'),
      fields: [
        choice('symptom', 'Symptom', ['Pain', 'Dyspnea', 'Pain and dyspnea']),
        num('severity', 'Severity (0–10)'),
        multi('interventions', 'Interventions tried (PRNs, positioning, O2, fan) and response'),
        multi('request', 'What you need (order change, continuous care, visit)'),
      ],
      defaultPriority: 'urgent',
      patientContext: true,
      order: 20,
    }),
  },
  {
    id: 'default-fall-report',
    template: tpl({
      title: 'Fall report',
      category: 'clinical',
      body: [
        'Fall report for {{patient}}',
        'Witnessed: {{witnessed}}',
        'Head strike: {{headStrike}}',
        'Injury observed: {{injury}}',
        'On anticoagulants: {{anticoagulant}}',
        'Actions taken: {{actions}}',
        'Caregiver notified: {{caregiverNotified}}',
        'Reported by {{me}}, {{myDiscipline}} at {{time}}.',
      ].join('\n'),
      fields: [
        choice('witnessed', 'Witnessed?', YES_NO),
        choice('headStrike', 'Head strike?', YES_NO_UNKNOWN),
        multi('injury', 'Injury observed (none, skin tear, bruising, deformity, pain)'),
        choice('anticoagulant', 'On anticoagulants?', YES_NO_UNKNOWN),
        multi('actions', 'Actions taken (assessment, first aid, repositioning, safety measures)'),
        choice('caregiverNotified', 'Caregiver notified?', YES_NO),
      ],
      defaultPriority: 'urgent',
      patientContext: true,
      order: 10,
    }),
  },
  {
    id: 'default-visit-update',
    template: tpl({
      title: 'Visit update',
      category: 'visit',
      body: [
        'Visit update for {{patient}} ({{date}})',
        'Comfort and status: {{status}}',
        'Symptoms and vitals: {{symptoms}}',
        'Changes to the plan: {{changes}}',
        'Next visit: {{nextVisit}}',
        '– {{me}}, {{myDiscipline}}',
      ].join('\n'),
      fields: [
        multi('status', 'Comfort and overall status'),
        multi('symptoms', 'Symptoms and vitals', false),
        multi('changes', 'Changes to the plan of care', false),
        text('nextVisit', 'Next visit', false),
      ],
      defaultPriority: 'normal',
      patientContext: true,
      order: 10,
    }),
  },
  {
    id: 'default-death-notification',
    template: tpl({
      title: 'Death notification to the team',
      category: 'end_of_life',
      body: [
        'With sadness we share that {{patient}} has died.',
        'Time of death: {{timeOfDeath}} on {{date}}',
        'Pronounced by: {{pronouncedBy}}',
        'Family present: {{familyPresent}}',
        'Funeral home: {{funeralHome}}',
        'Family needs and next steps: {{nextSteps}}',
        'Please coordinate bereavement follow-up and cancel upcoming visits. – {{me}}',
      ].join('\n'),
      fields: [
        text('timeOfDeath', 'Time of death'),
        text('pronouncedBy', 'Pronounced by'),
        choice('familyPresent', 'Family present?', YES_NO),
        text('funeralHome', 'Funeral home', false),
        multi('nextSteps', 'Family needs and next steps (DME pickup, med disposal, chaplain/SW)', false),
      ],
      defaultPriority: 'normal',
      patientContext: true,
      order: 10,
    }),
  },
  {
    id: 'default-medication-refill',
    template: tpl({
      title: 'Medication refill request',
      category: 'orders',
      body: [
        'Refill request for {{patient}}',
        'Medication: {{medication}}',
        'Remaining supply: {{remaining}}',
        'Pharmacy: {{pharmacy}}',
        'Please send the refill or a new order. Thank you. – {{me}}, {{myDiscipline}}',
      ].join('\n'),
      fields: [
        text('medication', 'Medication, strength and directions'),
        text('remaining', 'Remaining supply (doses or days)'),
        text('pharmacy', 'Pharmacy', false),
      ],
      defaultPriority: 'normal',
      patientContext: true,
      order: 10,
    }),
  },
  {
    id: 'default-comfort-kit',
    template: tpl({
      title: 'Comfort kit request',
      category: 'orders',
      body: [
        'Comfort kit request for {{patient}}',
        'Reason: {{reason}}',
        'Deliver to: {{deliverTo}}',
        'Needed by: {{neededBy}}',
        'Please send the order to the pharmacy. – {{me}}, {{myDiscipline}}',
      ].join('\n'),
      fields: [
        multi('reason', 'Reason (new admission, symptom escalation, kit used or expired)'),
        choice('deliverTo', 'Deliver to', ['Home', 'Facility']),
        text('neededBy', 'Needed by'),
      ],
      defaultPriority: 'normal',
      patientContext: true,
      order: 20,
    }),
  },
  {
    id: 'default-dme',
    template: tpl({
      title: 'DME order or pickup',
      category: 'logistics',
      body: [
        'DME {{action}} for {{patient}}',
        'Equipment: {{equipment}}',
        'Timing and access notes: {{notes}}',
        'Caregiver contact: {{caregiver}} {{caregiverPhone}}',
        '– {{me}}',
      ].join('\n'),
      fields: [
        choice('action', 'Request', ['order', 'pickup', 'exchange']),
        text('equipment', 'Equipment (hospital bed, oxygen concentrator, wheelchair…)'),
        multi('notes', 'Timing and access notes', false),
      ],
      defaultPriority: 'normal',
      patientContext: true,
      order: 10,
    }),
  },
  {
    id: 'default-family-update',
    template: tpl({
      title: 'Family update',
      category: 'family',
      body: [
        'Family update for {{patient}}',
        'Spoke with: {{caregiver}}',
        'Summary: {{summary}}',
        'Family questions or concerns: {{concerns}}',
        'Family requests a call back: {{callback}}',
        '– {{me}}, {{myDiscipline}}',
      ].join('\n'),
      fields: [
        multi('summary', 'What was discussed'),
        multi('concerns', 'Questions or concerns raised', false),
        choice('callback', 'Family requests a call back?', YES_NO),
      ],
      defaultPriority: 'normal',
      patientContext: true,
      order: 10,
    }),
  },
  {
    id: 'default-running-late',
    template: tpl({
      title: 'Running late',
      category: 'logistics',
      body: 'Running about {{minutes}} minutes late for my next visit. I will update you if that changes. – {{me}}',
      fields: [num('minutes', 'Minutes late')],
      defaultPriority: 'normal',
      patientContext: false,
      order: 20,
    }),
  },
  {
    id: 'default-call-me',
    template: tpl({
      title: 'Call me when free',
      category: 'logistics',
      body: 'Please call me when you are free. – {{me}}, {{myDiscipline}}',
      fields: [],
      defaultPriority: 'normal',
      patientContext: false,
      order: 30,
    }),
  },
];

function quickReplyId(text: string): string {
  return `default-qr-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

const QUICK_REPLIES: DefaultTemplate[] = DEFAULT_QUICK_REPLIES.map((reply, i) => ({
  id: quickReplyId(reply),
  template: tpl({
    title: reply,
    category: 'quick_reply',
    body: reply,
    fields: [],
    defaultPriority: 'normal',
    patientContext: false,
    order: (i + 1) * 10,
  }),
}));

/** The default org templates, in display order. */
export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [...CORE, ...QUICK_REPLIES];
