/**
 * Bereavement follow-up schedule (13 months after death) and the pure rules behind the
 * v3 bereavement workload (docs/PERSONA_REVIEW.md C1). Pure module: no Firebase imports.
 *
 * Default contacts (docs/DATA_MODEL.md, "Death"): condolence call day 3,
 * sympathy letter day 7, letters at months 1, 2, 3, 6 and 9, pre-anniversary
 * call month 11, anniversary letter month 12, closing call month 13.
 * v3 adds a risk reassessment (`assessment`) at month 1 for every plan, and for a
 * `high` risk level: an SW visit at 2 weeks plus monthly calls for the first 3 months.
 * The plan closes at death date + 13 months.
 *
 * Month arithmetic clamps to the end of the month: Jan 31 + 1 month = Feb 28
 * (or 29 in a leap year), never Mar 3.
 */
import type {
  Address,
  BereavementContact,
  BereavementContactType,
  BereavementMailingRow,
  BereavementPlan,
  BereavementRisk,
  BereavementSurvivor,
  Caregiver,
  Discipline,
  ISODate,
  Member,
} from '../shared/types';
import { addDays, compareISO, isoToUtcMillis } from './dates';

export const BEREAVEMENT_MONTHS = 13;

/** `iso` plus `months` calendar months, clamped to the last day of the target month. */
export function addMonthsClamped(iso: ISODate, months: number): ISODate {
  const d = new Date(isoToUtcMillis(iso));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + Math.trunc(months);
  const day = d.getUTCDate();
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
  return out.toISOString().slice(0, 10);
}

export interface ScheduledContact {
  id: string;
  type: BereavementContactType;
  label: string;
  dueDate: ISODate;
}

interface ContactSpec {
  id: string;
  type: BereavementContactType;
  label: string;
  days?: number;
  months?: number;
}

export const DEFAULT_BEREAVEMENT_CONTACTS: readonly ContactSpec[] = [
  { id: 'd3-call', type: 'call', label: 'Condolence call', days: 3 },
  { id: 'd7-letter', type: 'letter', label: 'Sympathy letter', days: 7 },
  { id: 'm1-letter', type: 'letter', label: 'Bereavement letter (month 1)', months: 1 },
  { id: 'm1-assessment', type: 'assessment', label: 'Risk reassessment (month 1)', months: 1 },
  { id: 'm2-letter', type: 'letter', label: 'Bereavement letter (month 2)', months: 2 },
  { id: 'm3-letter', type: 'letter', label: 'Bereavement letter (month 3)', months: 3 },
  { id: 'm6-letter', type: 'letter', label: 'Bereavement letter (month 6)', months: 6 },
  { id: 'm9-letter', type: 'letter', label: 'Bereavement letter (month 9)', months: 9 },
  { id: 'm11-call', type: 'call', label: 'Pre-anniversary call', months: 11 },
  { id: 'm12-letter', type: 'letter', label: 'Anniversary letter', months: 12 },
  { id: 'm13-call', type: 'call', label: 'Closing call', months: 13 },
];

/** Extra contacts for a `high` risk level (at plan creation or on reassessment). */
export const HIGH_RISK_CONTACTS: readonly ContactSpec[] = [
  { id: 'hr-d14-visit', type: 'visit', label: 'Social work visit (high risk)', days: 14 },
  { id: 'hr-m1-call', type: 'call', label: 'High-risk support call (month 1)', months: 1 },
  { id: 'hr-m2-call', type: 'call', label: 'High-risk support call (month 2)', months: 2 },
  { id: 'hr-m3-call', type: 'call', label: 'High-risk support call (month 3)', months: 3 },
];

function scheduleFrom(specs: readonly ContactSpec[], deathDate: ISODate): ScheduledContact[] {
  return specs.map((c) => ({
    id: c.id,
    type: c.type,
    label: c.label,
    dueDate: c.months !== undefined ? addMonthsClamped(deathDate, c.months) : addDays(deathDate, c.days ?? 0),
  }));
}

/** Stable sort by due date (ties keep list order). */
export function sortContacts<T extends { dueDate: ISODate }>(contacts: readonly T[]): T[] {
  return contacts
    .map((c, i) => ({ c, i }))
    .sort((a, b) => compareISO(a.c.dueDate, b.c.dueDate) || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * The contact schedule for a death on `deathDate`, sorted by due date. A `high` risk level
 * adds {@link HIGH_RISK_CONTACTS}.
 */
export function buildBereavementSchedule(deathDate: ISODate, riskLevel: BereavementRisk = 'low'): ScheduledContact[] {
  const specs = riskLevel === 'high' ? [...DEFAULT_BEREAVEMENT_CONTACTS, ...HIGH_RISK_CONTACTS] : DEFAULT_BEREAVEMENT_CONTACTS;
  return sortContacts(scheduleFrom(specs, deathDate));
}

/**
 * Contacts to append when a plan is reassessed as `high`: the high-risk contacts the plan
 * does not already have (by id). A contact whose natural due date is already past is due
 * `today` instead, so it shows up as work rather than as silently overdue.
 * Returns [] for any other level.
 */
export function highRiskAdditions(
  deathDate: ISODate,
  level: BereavementRisk,
  existingIds: Iterable<string>,
  today: ISODate,
): ScheduledContact[] {
  if (level !== 'high') return [];
  const have = new Set(existingIds);
  return scheduleFrom(HIGH_RISK_CONTACTS, deathDate)
    .filter((c) => !have.has(c.id))
    .map((c) => (compareISO(c.dueDate, today) < 0 ? { ...c, dueDate: today } : c));
}

/** A pending contact in the stored shape. */
export function pendingContact(c: ScheduledContact): BereavementContact {
  return { ...c, status: 'pending', completedAt: null, completedBy: null, note: null };
}

/** Date the plan closes: death date + 13 months (clamped). */
export function bereavementClosesOn(deathDate: ISODate): ISODate {
  return addMonthsClamped(deathDate, BEREAVEMENT_MONTHS);
}

// ---------------------------------------------------------------------------
// Survivors
// ---------------------------------------------------------------------------

export const EMPTY_ADDRESS: Address = { line1: null, line2: null, city: null, state: null, zip: null };

export function hasMailingAddress(a: Address | null | undefined): boolean {
  return !!a && !!a.line1?.trim() && ((!!a.city?.trim() && !!a.state?.trim()) || !!a.zip?.trim());
}

/** The primary survivor seeded from the patient's caregiver (id `primary`). */
export function survivorFromCaregiver(caregiver: Caregiver | null | undefined): BereavementSurvivor | null {
  if (!caregiver?.name?.trim()) return null;
  const address = caregiver.address ? { ...EMPTY_ADDRESS, ...caregiver.address } : { ...EMPTY_ADDRESS };
  const email = caregiver.email?.trim() || null;
  return {
    id: 'primary',
    name: caregiver.name.trim(),
    relationship: caregiver.relationship ?? null,
    phone: caregiver.phone ?? null,
    email,
    address,
    // Letters are the default bereavement channel; fall back to phone only when no address or email is known.
    preferredContact: hasMailingAddress(address) ? 'mail' : email ? 'email' : 'phone',
    doNotContact: false,
    isPrimary: true,
  };
}

/** A plan's survivors; plans created before v3 fall back to `primaryContact`. */
export function planSurvivors(plan: Pick<BereavementPlan, 'survivors' | 'primaryContact'>): BereavementSurvivor[] {
  if (Array.isArray(plan.survivors)) return plan.survivors;
  const s = survivorFromCaregiver(plan.primaryContact);
  return s ? [s] : [];
}

/** Legacy `primaryContact` mirror of the primary (or first contactable) survivor. */
export function primaryContactFrom(survivors: readonly BereavementSurvivor[]): BereavementPlan['primaryContact'] {
  const s = survivors.find((x) => x.isPrimary) ?? survivors.find((x) => !x.doNotContact) ?? survivors[0];
  if (!s) return null;
  return { name: s.name, relationship: s.relationship, phone: s.phone, address: s.address, ...(s.email ? { email: s.email } : {}) };
}

/** Survivors who may receive a mailing: not do-not-contact and not phone-only. */
export function mailingSurvivors(survivors: readonly BereavementSurvivor[]): BereavementSurvivor[] {
  return survivors.filter((s) => !s.doNotContact && s.preferredContact !== 'phone');
}

// ---------------------------------------------------------------------------
// Mailing export
// ---------------------------------------------------------------------------

export interface MailingPlan extends Pick<BereavementPlan, 'patientName' | 'contacts' | 'status' | 'survivors' | 'primaryContact'> {
  id: string;
}

/**
 * Mailing rows: one per (pending contact of an included type due in [from, to]) × (mailing
 * survivor). Contacts whose plan has no mailing survivor produce no row. Sorted by due date,
 * then family, then survivor.
 */
export function buildMailingRows(
  plans: readonly MailingPlan[],
  from: ISODate,
  to: ISODate,
  types: readonly BereavementContactType[],
): BereavementMailingRow[] {
  const rows: BereavementMailingRow[] = [];
  for (const plan of plans) {
    if (plan.status !== 'active') continue;
    const recipients = mailingSurvivors(planSurvivors(plan));
    if (recipients.length === 0) continue;
    for (const c of plan.contacts ?? []) {
      if (c.status !== 'pending' || !types.includes(c.type)) continue;
      if (compareISO(c.dueDate, from) < 0 || compareISO(c.dueDate, to) > 0) continue;
      for (const s of recipients) {
        rows.push({
          planId: plan.id,
          contactId: c.id,
          contactLabel: c.label,
          contactType: c.type,
          dueDate: c.dueDate,
          patientName: plan.patientName,
          survivorId: s.id,
          survivorName: s.name,
          relationship: s.relationship,
          preferredContact: s.preferredContact,
          email: s.email,
          address: { ...EMPTY_ADDRESS, ...s.address },
        });
      }
    }
  }
  return rows.sort(
    (a, b) =>
      compareISO(a.dueDate, b.dueDate) ||
      a.patientName.localeCompare(b.patientName) ||
      a.planId.localeCompare(b.planId) ||
      a.survivorName.localeCompare(b.survivorName),
  );
}

/** Distinct `planId → contactIds` in mailing rows. */
export function contactsByPlan(rows: ReadonlyArray<Pick<BereavementMailingRow, 'planId' | 'contactId'>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.planId) ?? [];
    if (!list.includes(r.contactId)) list.push(r.contactId);
    out.set(r.planId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-close
// ---------------------------------------------------------------------------

/**
 * Daily auto-close decision for a plan:
 *  - `close`: active, `closesOn` is before `today`, and every contact is done or skipped;
 *  - `review`: active and expired, but a contact is still pending (flag `needsReview`);
 *  - `none`: anything else.
 */
export function autoCloseDecision(plan: Pick<BereavementPlan, 'status' | 'closesOn' | 'contacts'>, today: ISODate): 'close' | 'review' | 'none' {
  if (plan.status !== 'active' || !plan.closesOn || compareISO(plan.closesOn, today) >= 0) return 'none';
  return (plan.contacts ?? []).every((c) => c.status !== 'pending') ? 'close' : 'review';
}

// ---------------------------------------------------------------------------
// Permissions (H4)
// ---------------------------------------------------------------------------

/** Disciplines that may work any bereavement plan without the capability. */
export const BEREAVEMENT_DISCIPLINES: readonly Discipline[] = ['SW', 'Chaplain'];

/** Admin / `bereavement` capability, or an SW / Chaplain: may work every plan. */
export function canWorkAllBereavementPlans(member: Pick<Member, 'role' | 'capabilities' | 'discipline'>): boolean {
  return member.role === 'admin' || (member.capabilities ?? []).includes('bereavement') || BEREAVEMENT_DISCIPLINES.includes(member.discipline);
}

/** May `member` (uid `uid`) change `plan`? All-plans access, or the plan's coordinator. */
export function canWorkBereavementPlan(
  member: Pick<Member, 'role' | 'capabilities' | 'discipline'>,
  uid: string,
  plan: Pick<BereavementPlan, 'assignedUid'>,
): boolean {
  return canWorkAllBereavementPlans(member) || (!!plan.assignedUid && plan.assignedUid === uid);
}
