// Runtime mirrors of the constants in @shared/types (which we may only import as types).
import type {
  AlertStatus,
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
export const PATIENT_STATUSES: readonly PatientStatus[] = ['referral', 'admitted', 'discharged', 'deceased'];
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
  'uploaded', 'extracting', 'needs_review', 'accepted', 'rejected', 'failed',
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
