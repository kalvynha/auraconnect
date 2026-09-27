// Runtime mirrors of the constants in @shared/types (which we may only import as types).
import type {
  AlertStatus,
  AuditAction,
  Capability,
  BereavementContactStatus,
  DischargeReason,
  DocumentCategory,
  Org,
  TaskStatus,
  TaskTemplateEvent,
  TaskTemplateItem,
  TriageDisposition,
  TriageUrgency,
  VisitStatus,
  VolunteerActivity,
  CodeStatus,
  Discipline,
  LevelOfCare,
  PatientStatus,
  Priority,
  ReferralStatus,
  Role,
  Sex,
} from '@shared/types';

export const ROLES: readonly Role[] = ['admin', 'clinician', 'intake', 'viewer'];
export const DISCIPLINES: readonly Discipline[] = [
  'RN', 'LPN', 'MD', 'NP', 'SW', 'Chaplain', 'Aide', 'Volunteer', 'Admin', 'Other',
];
export const PRIORITIES: readonly Priority[] = ['normal', 'urgent', 'critical'];
export const ALERT_STATUSES: readonly AlertStatus[] = ['open', 'acked', 'resolved'];
export const PATIENT_STATUSES: readonly PatientStatus[] = ['referral', 'admitted', 'discharged', 'deceased', 'non_admit'];
export const LEVELS_OF_CARE: readonly LevelOfCare[] = ['routine', 'continuous', 'respite', 'gip'];
export const LEVEL_OF_CARE_LABELS: Record<LevelOfCare, string> = {
  routine: 'Routine home care',
  continuous: 'Continuous home care',
  respite: 'Inpatient respite',
  gip: 'General inpatient (GIP)',
};
export const CODE_STATUSES: readonly CodeStatus[] = ['Full Code', 'DNR', 'DNR/DNI', 'Comfort Care Only', 'Unknown'];
export const SEXES: readonly Sex[] = ['female', 'male', 'other', 'unknown'];
export const REFERRAL_STATUSES: readonly ReferralStatus[] = [
  'uploaded', 'extracting', 'needs_review', 'accepted', 'rejected', 'failed', 'non_admit',
];

export const TIMEZONES: readonly string[] = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
];

/** Roles allowed to work with referrals and admissions. */
export const INTAKE_ROLES: readonly Role[] = ['admin', 'clinician', 'intake'];

// ---------------------------------------------------------------------------
// v2
// ---------------------------------------------------------------------------

/** Mirror of ORG_SETTING_DEFAULTS in @shared/types. */
export const ORG_SETTING_DEFAULTS = {
  triageRoleKey: null as string | null,
  idgCadenceDays: 15,
  missedVisitGraceMinutes: 120,
  messageLifespanDays: null as number | null,
  missedVisitAlertMode: 'assignee' as import('@shared/types').MissedVisitAlertMode,
};

export type OrgSettings = typeof ORG_SETTING_DEFAULTS;

/** Org settings with v2 defaults applied (older org docs lack these fields). */
export function orgSettings(org: Partial<Org> | null | undefined): OrgSettings {
  return {
    triageRoleKey: org?.triageRoleKey ?? ORG_SETTING_DEFAULTS.triageRoleKey,
    idgCadenceDays: org?.idgCadenceDays ?? ORG_SETTING_DEFAULTS.idgCadenceDays,
    missedVisitGraceMinutes: org?.missedVisitGraceMinutes ?? ORG_SETTING_DEFAULTS.missedVisitGraceMinutes,
    messageLifespanDays: org?.messageLifespanDays ?? ORG_SETTING_DEFAULTS.messageLifespanDays,
    missedVisitAlertMode: org?.missedVisitAlertMode ?? ORG_SETTING_DEFAULTS.missedVisitAlertMode,
  };
}

/** "Clinical" roles in the v2 contract: may run lifecycle, visit, IDG and triage mutations. */
export const CLINICAL_ROLES: readonly Role[] = ['admin', 'clinician', 'intake'];

export const DISCHARGE_REASON_LABELS: Record<DischargeReason, string> = {
  revocation: 'Revocation',
  transfer: 'Transfer to another hospice',
  no_longer_terminally_ill: 'No longer terminally ill',
  moved_out_of_area: 'Moved out of service area',
  for_cause: 'Discharge for cause',
  other: 'Other',
};

export const VISIT_STATUSES: readonly VisitStatus[] = ['scheduled', 'completed', 'missed', 'cancelled'];
export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'done', 'cancelled'];
export const TASK_TEMPLATE_EVENTS: readonly TaskTemplateEvent[] = ['admission', 'recertification', 'discharge', 'death'];

const tpl = (title: string, discipline: Discipline, offsetDays: number): TaskTemplateItem => ({
  title,
  description: null,
  discipline,
  offsetDays,
  priority: 'normal',
});

/** Defaults the backend applies when an org has no templates (DATA_MODEL v2). */
export const DEFAULT_TASK_TEMPLATES: Record<TaskTemplateEvent, TaskTemplateItem[]> = {
  admission: [
    tpl('Comprehensive assessment', 'RN', 5),
    tpl('Medication reconciliation', 'RN', 1),
    tpl('DME needs review', 'RN', 2),
    tpl('Social work assessment', 'SW', 5),
    tpl('Spiritual assessment', 'Chaplain', 5),
    tpl('Initial plan of care', 'MD', 5),
  ],
  recertification: [tpl('Update plan of care', 'RN', 0), tpl('Physician narrative', 'MD', 0)],
  discharge: [
    tpl('Discharge summary', 'RN', 2),
    tpl('Notify attending physician', 'RN', 1),
    tpl('Coordinate DME pickup', 'SW', 3),
  ],
  death: [
    tpl('Notify attending physician', 'RN', 0),
    tpl('Coordinate DME pickup', 'SW', 2),
    tpl('Medication disposal documentation', 'RN', 1),
    tpl('Bereavement assessment', 'SW', 7),
    tpl('Death summary', 'RN', 2),
  ],
};

export const BEREAVEMENT_RISKS = ['low', 'moderate', 'high'] as const;
export type BereavementRisk = (typeof BEREAVEMENT_RISKS)[number];
export const BEREAVEMENT_CONTACT_STATUSES: readonly BereavementContactStatus[] = ['pending', 'done', 'skipped'];

export const TRIAGE_URGENCIES: readonly TriageUrgency[] = ['routine', 'urgent', 'emergent'];
export const TRIAGE_DISPOSITION_LABELS: Record<TriageDisposition, string> = {
  advice_given: 'Advice given',
  visit_scheduled: 'Visit scheduled',
  visit_made: 'Visit made',
  md_contacted: 'MD contacted',
  ems_911: 'EMS / 911',
  other: 'Other',
};

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  consent: 'Consent',
  polst: 'POLST / DNR',
  order: 'Order',
  referral: 'Referral',
  plan_of_care: 'Plan of care',
  other: 'Other',
};

export const VOLUNTEER_ACTIVITIES: readonly VolunteerActivity[] = [
  'companionship', 'respite', 'vigil', 'errands', 'bereavement', 'admin', 'other',
];

// ---------------------------------------------------------------------------
// v3
// ---------------------------------------------------------------------------

/** Mirror of CAPABILITIES in @shared/types. */
export const CAPABILITIES: readonly Capability[] = ['reports', 'audit', 'staffing', 'scheduling', 'volunteers', 'bereavement'];
export const CAPABILITY_LABELS: Record<Capability, string> = {
  reports: 'Reports: dashboards, metrics, compliance reports, exports',
  audit: 'Audit: read the audit log',
  staffing: 'Staffing: edit care teams, reassign visits/tasks, offboarding',
  scheduling: 'Scheduling: schedule/reassign any visit, visit plans, shifts',
  volunteers: 'Volunteers: manage assignments and logs for volunteers',
  bereavement: 'Bereavement: manage all plans and mailings',
};

/** Mirror of the AuditAction union in @shared/types (for the audit-log filter). */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'org.create', 'member.invite', 'member.join', 'channel.create', 'channel.members.update',
  'patient.admit', 'patient.update', 'referral.extract', 'referral.accept', 'referral.reject',
  'referral.create', 'referral.retry', 'referral.claim', 'referral.non_admit', 'invite.revoke',
  'alert.create', 'alert.ack', 'alert.resolve', 'alert.escalate',
  'milestone.complete', 'milestone.reopen', 'patient.level_of_care', 'patient.recertify', 'patient.discharge', 'patient.death',
  'visit.schedule', 'visit.update', 'visit.complete', 'visit.cancel', 'visit.missed',
  'task.create', 'task.update', 'task.complete', 'bereavement.update',
  'idg.create', 'idg.update', 'idg.complete', 'idg.ai_prep',
  'triage.log', 'triage.assign', 'triage.resolve', 'document.upload',
  'message.recall', 'message.search', 'broadcast.send', 'ai.summarize_channel', 'ai.handoff',
  'volunteer.assign', 'volunteer.log',
  'bereavement.reassess', 'bereavement.mailing_export', 'bereavement.close',
  'volunteer.void', 'volunteer.sync', 'volunteer.report', 'volunteer.staff_hours',
  'visit.reassign', 'visit.plan', 'patient.care_team', 'member.update', 'member.deactivate', 'member.offboard',
  'org.settings_update', 'report.compliance', 'report.census',
];

// v3 intake — mirrors of the constants in @shared/types ("v3 — intake").
/** Referral file types accepted everywhere (web, iOS, rules, extractor). */
export const REFERRAL_MIME_TYPES: readonly string[] = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
];
export const REFERRAL_STALE_MINUTES = 6;
export const REFERRAL_RETRY_COOLDOWN_MINUTES = 2;
export const REFERRAL_CLAIM_MINUTES = 30;
export const NON_ADMIT_REASON_LABELS: Record<import('@shared/types').NonAdmitReason, string> = {
  died_before_admission: 'Died before admission',
  not_eligible: 'Not eligible (not terminally ill / criteria not met)',
  declined_hospice: 'Patient or family declined hospice',
  chose_other_provider: 'Chose another hospice or provider',
  unable_to_contact: 'Unable to contact',
  moved_out_of_area: 'Moved out of service area',
  no_payer: 'No payer / insurance issue',
  other: 'Other (explain in note)',
};
