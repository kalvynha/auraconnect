/**
 * Shared AuraConnect data contract.
 *
 * This file is the single source of truth for Firestore document shapes and
 * callable-function payloads. It is imported by Cloud Functions and (via the
 * `@shared` alias) by the web admin console. The iOS models in
 * `ios/AuraConnect/Core/Models` mirror these types by hand.
 *
 * Conventions:
 *  - Every org-scoped document lives under `orgs/{orgId}/...`.
 *  - Calendar dates (DOB, admission, deadlines) are ISO `YYYY-MM-DD` strings
 *    so they never shift across time zones. Instants are Firestore Timestamps
 *    (typed here as `TimestampLike` so this file has no SDK dependency).
 *  - Optional-but-present fields use `null`, never `undefined`, so documents
 *    always have a stable shape for Swift decoding.
 */

/** Firestore Timestamp in any SDK (admin, web, or a plain JSON-ish value). */
export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toDate?: () => Date;
  toMillis?: () => number;
}

/** ISO calendar date, `YYYY-MM-DD`. */
export type ISODate = string;

// ---------------------------------------------------------------------------
// Organization, members, teams
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'clinician' | 'intake' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'clinician', 'intake', 'viewer'];

export type Discipline =
  | 'RN'
  | 'LPN'
  | 'MD'
  | 'NP'
  | 'SW'
  | 'Chaplain'
  | 'Aide'
  | 'Volunteer'
  | 'Admin'
  | 'Other';
export const DISCIPLINES: readonly Discipline[] = [
  'RN', 'LPN', 'MD', 'NP', 'SW', 'Chaplain', 'Aide', 'Volunteer', 'Admin', 'Other',
];

/** Custom auth claims set by Cloud Functions. One org per user in the MVP. */
export interface AuraClaims {
  orgId: string;
  role: Role;
}

/** `orgs/{orgId}` */
export interface Org {
  name: string;
  /** IANA time zone used for deadline checks, e.g. `America/New_York`. */
  timezone: string;
  /** Days before a hospice deadline at which a reminder alert is raised. */
  deadlineLeadDays: number;
  /** Escalation policy applied to urgent/critical messages and deadline alerts. */
  defaultEscalationPolicyId: string | null;
  /**
   * Optional org settings added in v2. Absent on older orgs — readers must apply the
   * defaults shown (see `ORG_SETTING_DEFAULTS`).
   */
  /** On-call role that after-hours triage calls route to (default `null` → caller picks). */
  triageRoleKey?: string | null;
  /** Days between IDG plan-of-care reviews (CMS: at least every 15 days). Default 15. */
  idgCadenceDays?: number;
  /** A scheduled visit becomes `missed` this many minutes after its end. Default 120. */
  missedVisitGraceMinutes?: number;
  /** Messages older than this are purged daily; null = keep forever (default). */
  messageLifespanDays?: number | null;
  createdBy: string;
  createdAt: TimestampLike;
}

export const ORG_SETTING_DEFAULTS = {
  triageRoleKey: null as string | null,
  idgCadenceDays: 15,
  missedVisitGraceMinutes: 120,
  messageLifespanDays: null as number | null,
};

/** `orgs/{orgId}/members/{uid}` */
export interface Member {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  discipline: Discipline;
  title: string | null;
  phone: string | null;
  teamIds: string[];
  active: boolean;
  /** FCM registration tokens for this user's devices. */
  fcmTokens: string[];
  createdAt: TimestampLike;
  /** v3: extra permissions granted by an admin without making the member an admin. */
  capabilities?: Capability[];
}

/**
 * v3 capabilities. Admins implicitly hold all of them.
 *  - reports:     dashboards, metrics, compliance reports, exports
 *  - audit:       read the audit log
 *  - staffing:    edit care teams, reassign visits/tasks, offboarding preview
 *  - scheduling:  schedule/reassign/cancel any visit, generate visit plans, manage shifts
 *  - volunteers:  manage volunteer assignments, enter/void logs for volunteers
 *  - bereavement: manage all bereavement plans and mailings
 */
export type Capability = 'reports' | 'audit' | 'staffing' | 'scheduling' | 'volunteers' | 'bereavement';
export const CAPABILITIES: readonly Capability[] = ['reports', 'audit', 'staffing', 'scheduling', 'volunteers', 'bereavement'];

/**
 * v3: disciplines allowed to perform licensed lifecycle acts (record death, discharge,
 * level-of-care change, recertification, milestone reopen, clinical updates such as code
 * status). Admins may always perform them.
 */
export const LICENSED_DISCIPLINES: readonly Discipline[] = ['RN', 'NP', 'MD'];
/** v3: disciplines that may post messages and complete their own visits even with role `viewer`. */
export const FIELD_DISCIPLINES: readonly Discipline[] = ['Aide', 'LPN'];

/** `orgs/{orgId}/invites/{inviteId}` */
export interface Invite {
  /** Lower-cased email the invite is bound to. */
  email: string;
  displayName: string;
  role: Role;
  discipline: Discipline;
  teamIds: string[];
  status: 'pending' | 'accepted' | 'revoked';
  createdBy: string;
  createdAt: TimestampLike;
  acceptedBy: string | null;
  acceptedAt: TimestampLike | null;
}

/** `orgs/{orgId}/teams/{teamId}` */
export interface Team {
  name: string;
  description: string | null;
  memberUids: string[];
  createdAt: TimestampLike;
}

/** Top-level `userOrgs/{uid}` lookup so a signed-in user can find their org before claims refresh. */
export interface UserOrg {
  orgId: string;
  role: Role;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/** `broadcast`: only the creator can post; recipients read (and get pushed) but cannot reply. */
export type ChannelType = 'direct' | 'group' | 'patient' | 'team' | 'broadcast';
export type Priority = 'normal' | 'urgent' | 'critical';
export const PRIORITIES: readonly Priority[] = ['normal', 'urgent', 'critical'];

export interface LastMessage {
  text: string;
  senderUid: string;
  senderName: string;
  priority: Priority;
  at: TimestampLike;
}

/** `orgs/{orgId}/channels/{channelId}` — direct channel ids are `dm_{uidA}_{uidB}` (sorted). */
export interface Channel {
  type: ChannelType;
  /** Display name; null for direct channels (clients show the other member's name). */
  name: string | null;
  memberUids: string[];
  patientId: string | null;
  teamId: string | null;
  createdBy: string;
  createdAt: TimestampLike;
  lastMessage: LastMessage | null;
  /** Mirrors lastMessage.at (or createdAt) so channels can be ordered by activity. */
  lastMessageAt: TimestampLike;
  archived: boolean;
}

export interface Attachment {
  /** Storage path: `orgs/{orgId}/channels/{channelId}/attachments/{fileName}`. */
  storagePath: string;
  contentType: string;
  name: string;
  size: number;
}

/** `orgs/{orgId}/channels/{channelId}/messages/{messageId}` — written directly by clients. */
export interface Message {
  senderUid: string;
  senderName: string;
  body: string;
  priority: Priority;
  attachments: Attachment[];
  /** Set when the message was addressed to an on-call role (e.g. `oncall-rn-north`). */
  roleTarget: string | null;
  /** Set by clients to `serverTimestamp()`. */
  createdAt: TimestampLike;
  /** Set by the backend when an urgent/critical message raised an alert. */
  alertId: string | null;
  // --- v2 (all optional on read; old messages lack them) ---
  /**
   * Thread replies point at their parent message id. Clients MAY include it on create
   * (string or null). Channel timelines show messages where this is absent/null.
   */
  threadParentId?: string | null;
  /** Backend-maintained on parent messages: number of thread replies. */
  replyCount?: number;
  /** Backend-maintained on parent messages. */
  lastReplyAt?: TimestampLike | null;
  /** Set by `recallMessage`; body/attachments are then emptied. Clients show "Message recalled". */
  recalledAt?: TimestampLike | null;
}

/** Fields a client writes when creating a message. `threadParentId` is optional. */
export const MESSAGE_CREATE_KEYS = [
  'senderUid', 'senderName', 'body', 'priority', 'attachments', 'roleTarget', 'createdAt', 'alertId',
] as const;

/** `orgs/{orgId}/channels/{channelId}/reads/{uid}` — read receipts. */
export interface ReadReceipt {
  lastReadAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// Scheduling & escalation
// ---------------------------------------------------------------------------

/** `orgs/{orgId}/onCallRoles/{roleKey}` — addressable roles such as `oncall-rn-north`. */
export interface OnCallRole {
  label: string;
  discipline: Discipline | null;
  teamId: string | null;
  /** Used when nobody is scheduled for this role. */
  fallbackUids: string[];
}

/** `orgs/{orgId}/shifts/{shiftId}` — who holds a role for a time range. */
export interface Shift {
  roleKey: string;
  uid: string;
  start: TimestampLike;
  end: TimestampLike;
  notes: string | null;
}

export type EscalationTarget =
  | { kind: 'role'; roleKey: string }
  | { kind: 'uid'; uid: string }
  /** The alert's original recipients (useful as step 0). */
  | { kind: 'original' };

export interface EscalationStep {
  target: EscalationTarget;
  /** Minutes to wait for an acknowledgement before moving to the next step. */
  waitMinutes: number;
}

/** `orgs/{orgId}/escalationPolicies/{policyId}` */
export interface EscalationPolicy {
  name: string;
  steps: EscalationStep[];
}

export type AlertStatus = 'open' | 'acked' | 'resolved';

export type AlertSource =
  | { type: 'message'; channelId: string; messageId: string }
  | { type: 'deadline'; patientId: string; milestone: MilestoneKind; dueDate: ISODate }
  | { type: 'manual'; patientId: string | null }
  | { type: 'triage'; callId: string; patientId: string | null }
  | { type: 'visit_missed'; visitId: string; patientId: string };

export interface AlertEscalationEvent {
  level: number;
  targetUids: string[];
  at: TimestampLike;
}

/** `orgs/{orgId}/alerts/{alertId}` */
export interface Alert {
  title: string;
  body: string;
  priority: Priority;
  source: AlertSource;
  /** Everyone who has been notified so far (accumulates as the alert escalates). */
  targetUids: string[];
  /** Recipients at the current escalation level. */
  currentTargetUids: string[];
  policyId: string | null;
  /** Current escalation level (index into policy.steps). */
  level: number;
  /** True when the last policy step has been reached without an ack. */
  exhausted: boolean;
  status: AlertStatus;
  createdBy: string;
  createdAt: TimestampLike;
  ackedBy: string | null;
  ackedAt: TimestampLike | null;
  history: AlertEscalationEvent[];
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export type PatientStatus = 'referral' | 'admitted' | 'discharged' | 'deceased';
export type LevelOfCare = 'routine' | 'continuous' | 'respite' | 'gip';
export type CodeStatus = 'Full Code' | 'DNR' | 'DNR/DNI' | 'Comfort Care Only' | 'Unknown';
export type Sex = 'female' | 'male' | 'other' | 'unknown';

export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface Diagnosis {
  /** ICD-10-CM code, e.g. `C34.90`. */
  code: string | null;
  description: string;
}

export interface Physician {
  name: string;
  npi: string | null;
  phone: string | null;
  fax: string | null;
}

export interface Medication {
  name: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
}

export interface Caregiver {
  name: string;
  relationship: string | null;
  phone: string | null;
}

export interface Insurance {
  payer: string | null;
  memberId: string | null;
}

/** Clinical/demographic fields shared by referrals and patients. */
export interface PatientInput {
  firstName: string;
  lastName: string;
  dob: ISODate | null;
  sex: Sex;
  phone: string | null;
  address: Address;
  mrn: string | null;
  medicareMbi: string | null;
  primaryDiagnosis: Diagnosis | null;
  secondaryDiagnoses: Diagnosis[];
  referringPhysician: Physician | null;
  attendingPhysician: Physician | null;
  codeStatus: CodeStatus;
  allergies: string[];
  medications: Medication[];
  caregiver: Caregiver | null;
  insurance: Insurance;
}

export interface Consents {
  electionStatement: boolean;
  hipaaNotice: boolean;
  releaseOfInformation: boolean;
  patientRights: boolean;
  /** Present when code status is DNR-type and a POLST/DNR form is on file. */
  polstOnFile: boolean;
}

export type MilestoneKind = 'noe' | 'recert' | 'f2f' | 'hope_admission' | 'hope_huv1' | 'hope_huv2';

export interface BenefitPeriod {
  number: number;
  start: ISODate;
  end: ISODate;
  lengthDays: 90 | 60;
  /** Face-to-face encounter required for benefit period 3 and later. */
  f2fRequired: boolean;
  /** F2F must occur within 30 days before the period starts. */
  f2fWindowStart: ISODate | null;
  f2fDueBy: ISODate | null;
}

export interface Milestones {
  /** Notice of Election must be filed within 5 calendar days after the election date. */
  noeDueDate: ISODate;
  benefitPeriods: BenefitPeriod[];
  /** HOPE admission assessment: within 5 days of election. */
  hopeAdmissionDue: ISODate;
  /** HOPE Update Visit 1: days 6–15 of the stay. */
  hopeHuv1Window: { start: ISODate; end: ISODate };
  /** HOPE Update Visit 2: days 16–30 of the stay. */
  hopeHuv2Window: { start: ISODate; end: ISODate };
  computedAt: ISODate;
}

/** `orgs/{orgId}/patients/{patientId}` */
export interface Patient extends PatientInput {
  status: PatientStatus;
  referralId: string | null;
  admissionDate: ISODate | null;
  /** Benefit period the patient is in at admission (>1 when transferring from another hospice). */
  startingBenefitPeriod: number;
  levelOfCare: LevelOfCare;
  careTeamUids: string[];
  channelId: string | null;
  consents: Consents | null;
  milestones: Milestones | null;
  /** Milestone keys (e.g. `noe:2026-10-01`) for which reminder alerts were already raised. */
  remindedMilestones: string[];
  // --- v2 (optional on read) ---
  /**
   * Completed/filed milestones keyed by milestone key (`{kind}:{dueDate}`, same format as
   * `remindedMilestones`). `checkDeadlines` never alerts on a completed key.
   */
  milestoneCompletions?: Record<string, MilestoneCompletion>;
  /** Planned visit frequency per discipline. */
  visitFrequencies?: VisitFrequency[];
  /** Last IDG plan-of-care review (set when an IDG meeting that reviewed the patient completes). */
  lastIdgReviewDate?: ISODate | null;
  /** lastIdgReviewDate (or admissionDate) + org.idgCadenceDays. */
  nextIdgDueDate?: ISODate | null;
  dischargeDate?: ISODate | null;
  dischargeReason?: DischargeReason | null;
  death?: DeathRecord | null;
  bereavementPlanId?: string | null;
  createdBy: string;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// Referrals (scan + AI extraction)
// ---------------------------------------------------------------------------

export type ReferralStatus =
  | 'uploaded'
  | 'extracting'
  | 'needs_review'
  | 'accepted'
  | 'rejected'
  | 'failed';

export type ReferralSource = 'scan' | 'upload' | 'fax';

/** What the model extracts. Every field may be missing from the source document. */
export interface ReferralExtraction {
  patient: PatientInput;
  referralDate: ISODate | null;
  referralSource: string | null;
  reasonForReferral: string | null;
  /** Per-field confidence 0–1, keyed by dotted path (e.g. `patient.dob`). */
  fieldConfidence: Record<string, number>;
  /** Free-text notes the model flagged (illegible sections, conflicts). */
  warnings: string[];
}

/**
 * `orgs/{orgId}/referrals/{referralId}`.
 * The client creates this doc (status `uploaded`), then uploads the file to
 * `orgs/{orgId}/referrals/{referralId}/{fileName}`; the storage trigger runs extraction.
 */
export interface Referral {
  fileName: string;
  contentType: string;
  storagePath: string;
  source: ReferralSource;
  status: ReferralStatus;
  extracted: ReferralExtraction | null;
  error: string | null;
  model: string | null;
  patientId: string | null;
  uploadedBy: string;
  reviewedBy: string | null;
  rejectionReason: string | null;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'org.create'
  | 'member.invite'
  | 'member.join'
  | 'channel.create'
  | 'channel.members.update'
  | 'patient.admit'
  | 'patient.update'
  | 'referral.extract'
  | 'referral.accept'
  | 'referral.reject'
  | 'alert.create'
  | 'alert.ack'
  | 'alert.resolve'
  | 'alert.escalate'
  // v2
  | 'milestone.complete'
  | 'milestone.reopen'
  | 'patient.level_of_care'
  | 'patient.recertify'
  | 'patient.discharge'
  | 'patient.death'
  | 'visit.schedule'
  | 'visit.update'
  | 'visit.complete'
  | 'visit.cancel'
  | 'visit.missed'
  | 'task.create'
  | 'task.update'
  | 'task.complete'
  | 'bereavement.update'
  | 'idg.create'
  | 'idg.update'
  | 'idg.complete'
  | 'idg.ai_prep'
  | 'triage.log'
  | 'triage.assign'
  | 'triage.resolve'
  | 'document.upload'
  | 'message.recall'
  | 'message.search'
  | 'broadcast.send'
  | 'ai.summarize_channel'
  | 'ai.handoff'
  | 'volunteer.assign'
  | 'volunteer.log';

/** `orgs/{orgId}/auditLogs/{id}` — written only by Cloud Functions. */
export interface AuditLog {
  actorUid: string;
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  patientId: string | null;
  at: TimestampLike;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Callable function payloads (region: us-central1)
// ---------------------------------------------------------------------------

export interface CreateOrgRequest { name: string; timezone: string; displayName: string; discipline: Discipline }
export interface CreateOrgResponse { orgId: string }

export interface InviteMemberRequest {
  orgId: string;
  email: string;
  displayName: string;
  role: Role;
  discipline: Discipline;
  teamIds?: string[];
}
export interface InviteMemberResponse { inviteId: string }

export interface AcceptInviteRequest { orgId: string; inviteId: string }
export interface AcceptInviteResponse { orgId: string; role: Role }

/** `listMyInvites` — pending invites addressed to the caller's (verified) email. */
export interface MyInvite { orgId: string; inviteId: string; orgName: string; role: Role }
export interface ListMyInvitesResponse { invites: MyInvite[] }
export interface CreateChannelRequest {
  orgId: string;
  type: 'direct' | 'group' | 'team';
  memberUids: string[];
  name?: string;
  teamId?: string;
}
export interface CreateChannelResponse { channelId: string }

export interface UpdateChannelMembersRequest { orgId: string; channelId: string; add?: string[]; remove?: string[] }

export interface SendRoleMessageRequest { orgId: string; roleKey: string; body: string; priority: Priority }
export interface SendRoleMessageResponse { channelId: string; messageId: string; resolvedUids: string[] }

export interface CreateAlertRequest {
  orgId: string;
  title: string;
  body: string;
  priority: Priority;
  targetUids?: string[];
  roleKey?: string;
  policyId?: string;
  patientId?: string;
}
export interface CreateAlertResponse { alertId: string }

export interface AlertActionRequest { orgId: string; alertId: string }

export interface AdmitPatientRequest {
  orgId: string;
  /** Existing patient (e.g. created from a referral); omit to create a new one. */
  patientId?: string;
  patient: PatientInput;
  admissionDate: ISODate;
  startingBenefitPeriod?: number;
  levelOfCare: LevelOfCare;
  careTeamUids: string[];
  consents: Consents;
}
export interface AdmitPatientResponse { patientId: string; channelId: string }

export interface AcceptReferralRequest { orgId: string; referralId: string; patient: PatientInput }
export interface AcceptReferralResponse { patientId: string }

export interface RejectReferralRequest { orgId: string; referralId: string; reason: string }
export interface RetryReferralRequest { orgId: string; referralId: string }

/** FCM data payload. Never contains PHI — clients fetch content after authenticating. */
export interface PushData {
  type: 'message' | 'alert';
  orgId: string;
  channelId?: string;
  alertId?: string;
  priority: Priority;
}

// ===========================================================================
// v2 — Tier 1: lifecycle, milestones, visits, tasks, bereavement
// ===========================================================================

export interface MilestoneCompletion {
  completedAt: TimestampLike;
  completedBy: string;
  note: string | null;
}

export type DischargeReason =
  | 'revocation'
  | 'transfer'
  | 'no_longer_terminally_ill'
  | 'moved_out_of_area'
  | 'for_cause'
  | 'other';

export interface DeathRecord {
  date: ISODate;
  /** Local time `HH:mm` in the org time zone. */
  time: string | null;
  pronouncedBy: string | null;
  location: string | null;
  notes: string | null;
}

export type PatientEventType =
  | 'admission'
  | 'level_of_care_change'
  | 'recertification'
  | 'discharge'
  | 'death';

/** `orgs/{orgId}/patients/{patientId}/events/{eventId}` — timeline, written only by functions. */
export interface PatientEvent {
  type: PatientEventType;
  /** Effective date of the event. */
  date: ISODate;
  recordedBy: string;
  createdAt: TimestampLike;
  /** Human-readable one-liner shown in the timeline, e.g. "Level of care: routine → GIP". */
  summary: string;
  details: Record<string, unknown>;
}

export interface VisitFrequency {
  discipline: Discipline;
  /** Planned visits per week (may be fractional, e.g. 0.5 = every other week). */
  perWeek: number;
  notes: string | null;
}

export type VisitStatus = 'scheduled' | 'completed' | 'missed' | 'cancelled';

/** `orgs/{orgId}/visits/{visitId}` — written only by functions. */
export interface Visit {
  patientId: string;
  /** Denormalized "Last, First" for lists (PHI stays in Firestore; never in pushes). */
  patientName: string;
  discipline: Discipline;
  assignedUid: string | null;
  scheduledStart: TimestampLike;
  scheduledEnd: TimestampLike;
  status: VisitStatus;
  note: string | null;
  completedAt: TimestampLike | null;
  completedBy: string | null;
  cancelledReason: string | null;
  createdBy: string;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

export type TaskStatus = 'open' | 'done' | 'cancelled';
export type TaskTemplateEvent = 'admission' | 'recertification' | 'discharge' | 'death';

export type TaskSource =
  | { type: 'manual' }
  | { type: 'template'; event: TaskTemplateEvent }
  | { type: 'idg'; meetingId: string }
  | { type: 'triage'; callId: string };

/** `orgs/{orgId}/tasks/{taskId}` — written only by functions. */
export interface Task {
  title: string;
  description: string | null;
  patientId: string | null;
  patientName: string | null;
  assigneeUid: string | null;
  /** Used when unassigned: anyone on the care team with this discipline may pick it up. */
  discipline: Discipline | null;
  dueDate: ISODate | null;
  priority: Priority;
  status: TaskStatus;
  source: TaskSource;
  createdBy: string;
  createdAt: TimestampLike;
  completedAt: TimestampLike | null;
  completedBy: string | null;
  updatedAt: TimestampLike;
}

export interface TaskTemplateItem {
  title: string;
  description: string | null;
  /** Assigned to the patient's care-team member with this discipline, if any. */
  discipline: Discipline | null;
  /** Due date = event date + offsetDays. */
  offsetDays: number;
  priority: Priority;
}

/** `orgs/{orgId}/taskTemplates/{event}` — admin-editable; defaults created by `createOrg`/lazily. */
export interface TaskTemplate {
  event: TaskTemplateEvent;
  items: TaskTemplateItem[];
}

export type BereavementContactType = 'call' | 'letter' | 'visit' | 'mailing';
export type BereavementContactStatus = 'pending' | 'done' | 'skipped';

export interface BereavementContact {
  id: string;
  type: BereavementContactType;
  label: string;
  dueDate: ISODate;
  status: BereavementContactStatus;
  completedAt: TimestampLike | null;
  completedBy: string | null;
  note: string | null;
}

/** `orgs/{orgId}/bereavementPlans/{planId}` — created by `recordDeath`; 13-month follow-up. */
export interface BereavementPlan {
  patientId: string;
  patientName: string;
  deathDate: ISODate;
  primaryContact: Caregiver | null;
  riskLevel: 'low' | 'moderate' | 'high';
  assignedUid: string | null;
  contacts: BereavementContact[];
  status: 'active' | 'closed';
  /** deathDate + 13 months. */
  closesOn: ISODate;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

// ===========================================================================
// v2 — Tier 2: IDG meetings, after-hours triage, patient documents
// ===========================================================================

export interface IdgActionItem {
  title: string;
  assigneeUid: string | null;
  dueDate: ISODate | null;
}

export interface IdgPatientNote {
  summary: string;
  planOfCareChanges: string | null;
  goalsOfCare: string | null;
  actionItems: IdgActionItem[];
  reviewed: boolean;
  updatedBy: string;
  updatedAt: TimestampLike;
}

export interface IdgAiPrep {
  text: string;
  model: string;
  generatedAt: TimestampLike;
}

/** `orgs/{orgId}/idgMeetings/{meetingId}` — written only by functions. */
export interface IdgMeeting {
  title: string;
  teamId: string | null;
  scheduledAt: TimestampLike;
  status: 'scheduled' | 'completed';
  attendeeUids: string[];
  /** Agenda. Auto-populated with admitted patients whose nextIdgDueDate ≤ meeting date + 7 days. */
  patientIds: string[];
  /** Denormalized names keyed by patientId, for the agenda list. */
  patientNames: Record<string, string>;
  notes: Record<string, IdgPatientNote>;
  /** AI-generated prep packets keyed by patientId (human must verify). */
  aiPrep: Record<string, IdgAiPrep>;
  createdBy: string;
  createdAt: TimestampLike;
  completedAt: TimestampLike | null;
  completedBy: string | null;
}

export type TriageUrgency = 'routine' | 'urgent' | 'emergent';
export type TriageDisposition =
  | 'advice_given'
  | 'visit_scheduled'
  | 'visit_made'
  | 'md_contacted'
  | 'ems_911'
  | 'other';

/** `orgs/{orgId}/triageCalls/{callId}` — written only by functions. */
export interface TriageCall {
  patientId: string | null;
  patientName: string | null;
  callerName: string;
  callerRelationship: string | null;
  callerPhone: string | null;
  reason: string;
  symptoms: string[];
  urgency: TriageUrgency;
  status: 'open' | 'resolved';
  assignedUid: string | null;
  roleKey: string | null;
  alertId: string | null;
  disposition: TriageDisposition | null;
  dispositionNote: string | null;
  receivedAt: TimestampLike;
  receivedBy: string;
  resolvedAt: TimestampLike | null;
  resolvedBy: string | null;
}

export type DocumentCategory = 'consent' | 'polst' | 'order' | 'referral' | 'plan_of_care' | 'other';

/**
 * `orgs/{orgId}/patients/{patientId}/documents/{documentId}`.
 * Clients (admin/clinician/intake) create the doc, then upload to
 * `orgs/{orgId}/patients/{patientId}/documents/{documentId}/{fileName}`.
 * `acceptReferral` also adds the referral file here (category `referral`).
 */
export interface PatientDocument {
  name: string;
  category: DocumentCategory;
  fileName: string;
  storagePath: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  createdAt: TimestampLike;
}

// ===========================================================================
// v2 — Tier 3: messaging extras + AI
// ===========================================================================

export type BroadcastTarget =
  | { kind: 'team'; teamId: string }
  | { kind: 'role'; roleKey: string }
  | { kind: 'discipline'; discipline: Discipline }
  | { kind: 'all' };

export interface MessageSearchHit {
  channelId: string;
  channelName: string | null;
  messageId: string;
  senderName: string;
  /** ~160 chars around the match. */
  snippet: string;
  createdAt: TimestampLike;
}

export interface AiTextResult {
  text: string;
  model: string;
  /** Always shown to users: AI output must be verified by a clinician. */
  disclaimer: string;
}

// ===========================================================================
// v2 — Tier 4: dashboards, volunteers
// ===========================================================================

/** `orgs/{orgId}/metrics/{YYYY-MM-DD}` — computed daily (and on demand) by functions. */
export interface DailyMetrics {
  date: ISODate;
  census: { admitted: number; referral: number; dischargedToday: number; deathsToday: number };
  levelOfCare: Record<LevelOfCare, number>;
  alerts: { created: number; acked: number; medianAckMinutes: number | null; exhausted: number };
  deadlines: { dueNext7Days: number; overdue: number; completedOnTime30d: number; completedLate30d: number };
  visits: { scheduled: number; completed: number; missed: number; cancelled: number };
  triage: { calls: number; emergent: number; medianResolveMinutes: number | null };
  volunteers: { minutesLast30d: number; activeAssignments: number };
  bereavement: { activePlans: number; contactsDueNext7Days: number; contactsOverdue: number };
  computedAt: TimestampLike;
}

export type VolunteerActivity = 'companionship' | 'respite' | 'vigil' | 'errands' | 'bereavement' | 'admin' | 'other';

/** `orgs/{orgId}/volunteerAssignments/{id}` — admin-managed. */
export interface VolunteerAssignment {
  volunteerUid: string;
  patientId: string;
  patientName: string;
  activity: VolunteerActivity;
  status: 'active' | 'ended';
  startDate: ISODate;
  endDate: ISODate | null;
  notes: string | null;
  createdBy: string;
  createdAt: TimestampLike;
}

/** `orgs/{orgId}/volunteerLogs/{id}` — a volunteer logs their own time (CMS: volunteer hours ≥ 5% of patient-care hours). */
export interface VolunteerLog {
  volunteerUid: string;
  patientId: string | null;
  date: ISODate;
  minutes: number;
  activity: VolunteerActivity;
  note: string | null;
  createdAt: TimestampLike;
}

// ===========================================================================
// v2 callables (region us-central1; every request carries orgId)
// ===========================================================================

export interface CompleteMilestoneRequest { orgId: string; patientId: string; key: string; note?: string }
export interface ReopenMilestoneRequest { orgId: string; patientId: string; key: string }

export interface ChangeLevelOfCareRequest {
  orgId: string; patientId: string; levelOfCare: LevelOfCare; effectiveDate: ISODate; reason: string;
}
export interface RecordRecertificationRequest {
  orgId: string; patientId: string;
  /** Benefit period being certified (must exist in milestones.benefitPeriods). */
  periodNumber: number;
  certifyingPhysician: string;
  certificationDate: ISODate;
  /** Required when that period has f2fRequired. */
  f2fDate?: ISODate;
  f2fBy?: string;
}
export interface DischargePatientRequest {
  orgId: string; patientId: string; dischargeDate: ISODate; reason: DischargeReason; notes?: string;
}
export interface RecordDeathRequest {
  orgId: string; patientId: string; date: ISODate; time?: string; pronouncedBy?: string;
  location?: string; notes?: string; bereavementRisk?: 'low' | 'moderate' | 'high'; bereavementAssigneeUid?: string;
}

export interface SetVisitFrequenciesRequest { orgId: string; patientId: string; frequencies: VisitFrequency[] }
export interface ScheduleVisitRequest {
  orgId: string; patientId: string; discipline: Discipline; assignedUid?: string | null;
  /** ISO 8601 instants. */
  start: string; end: string; note?: string;
}
export interface UpdateVisitRequest {
  orgId: string; visitId: string; assignedUid?: string | null; start?: string; end?: string; note?: string | null;
}
export interface CompleteVisitRequest { orgId: string; visitId: string; note?: string }
export interface CancelVisitRequest { orgId: string; visitId: string; reason: string }

export interface CreateTaskRequest {
  orgId: string; title: string; description?: string; patientId?: string; assigneeUid?: string;
  discipline?: Discipline; dueDate?: ISODate; priority?: Priority;
}
export interface UpdateTaskRequest {
  orgId: string; taskId: string; title?: string; description?: string | null; assigneeUid?: string | null;
  dueDate?: ISODate | null; priority?: Priority; status?: TaskStatus;
}
export interface SaveTaskTemplateRequest { orgId: string; event: TaskTemplateEvent; items: TaskTemplateItem[] }

export interface UpdateBereavementContactRequest {
  orgId: string; planId: string; contactId: string; status: BereavementContactStatus; note?: string;
}
export interface UpdateBereavementPlanRequest {
  orgId: string; planId: string; assignedUid?: string | null; riskLevel?: 'low' | 'moderate' | 'high'; status?: 'active' | 'closed';
}

export interface CreateIdgMeetingRequest {
  orgId: string; title: string; scheduledAt: string; teamId?: string; attendeeUids?: string[];
  /** Omit to auto-populate with patients due for review. */
  patientIds?: string[];
}
export interface UpdateIdgMeetingRequest {
  orgId: string; meetingId: string; title?: string; scheduledAt?: string; attendeeUids?: string[]; patientIds?: string[];
}
export interface SaveIdgNoteRequest {
  orgId: string; meetingId: string; patientId: string; summary: string; planOfCareChanges?: string | null;
  goalsOfCare?: string | null; actionItems?: IdgActionItem[]; reviewed: boolean;
}
export interface CompleteIdgMeetingRequest { orgId: string; meetingId: string }
export interface GenerateIdgPrepRequest { orgId: string; meetingId: string; patientId?: string }

export interface LogTriageCallRequest {
  orgId: string; patientId?: string; callerName: string; callerRelationship?: string; callerPhone?: string;
  reason: string; symptoms?: string[]; urgency: TriageUrgency;
  /** Defaults to org.triageRoleKey. Emergent/urgent calls raise an escalating alert to the on-call person. */
  roleKey?: string; assignedUid?: string;
}
export interface LogTriageCallResponse { callId: string; assignedUid: string | null; alertId: string | null }
export interface AssignTriageCallRequest { orgId: string; callId: string; assignedUid: string }
export interface ResolveTriageCallRequest {
  orgId: string; callId: string; disposition: TriageDisposition; dispositionNote?: string;
  /** Optional follow-up task. */
  followUpTask?: { title: string; assigneeUid?: string; dueDate?: ISODate };
}

export interface RecallMessageRequest { orgId: string; channelId: string; messageId: string }
export interface SearchMessagesRequest { orgId: string; query: string; channelId?: string }
export interface SearchMessagesResponse { hits: MessageSearchHit[]; truncated: boolean }
export interface SendBroadcastRequest { orgId: string; name: string; target: BroadcastTarget; body: string; priority: Priority }
export interface SendBroadcastResponse { channelId: string; messageId: string; recipientCount: number }

export interface SummarizeChannelRequest { orgId: string; channelId: string; sinceHours?: number }
export interface GenerateHandoffRequest { orgId: string; sinceHours?: number; patientIds?: string[] }

export interface ComputeMetricsRequest { orgId: string }
export interface ComputeMetricsResponse { metrics: DailyMetrics }

/** Generic id response used by create* callables. */
export interface IdResponse { id: string }
