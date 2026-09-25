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
  createdBy: string;
  createdAt: TimestampLike;
}

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
}

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

export type ChannelType = 'direct' | 'group' | 'patient' | 'team';
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
}

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
  | { type: 'manual'; patientId: string | null };

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
  | 'alert.escalate';

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
