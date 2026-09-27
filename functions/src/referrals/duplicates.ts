/**
 * I4: possible-duplicate detection for referrals.
 *
 * Matches, per org:
 *  - patients with the same Medicare MBI, or the same last name + DOB;
 *  - referrals created in the last {@link DUPLICATE_REFERRAL_LOOKBACK_DAYS} days whose
 *    extracted patient has the same MBI, or the same last name + DOB.
 * Last names are matched on a few case variants ("LEE", "Lee", "lee") so a fax in capitals
 * still matches; MBIs are compared upper-cased without spaces or dashes.
 *
 * Indexes (firestore.indexes.json): patients(lastName, dob);
 * referrals(extracted.patient.medicareMbi, createdAt) and referrals(extracted.patient.lastName, createdAt).
 */
import { Timestamp } from 'firebase-admin/firestore';
import { colRef, paths } from '../lib/db';
import type { DuplicateMatch, Patient, PatientInput, Referral } from '../shared/types';

export const DUPLICATE_REFERRAL_LOOKBACK_DAYS = 30;
const MAX_PER_QUERY = 10;

export function normalizeMbi(mbi: string | null | undefined): string | null {
  const v = (mbi ?? '').replace(/[\s-]+/g, '').toUpperCase();
  return v.length >= 6 ? v : null;
}

/** Case variants of a last name used for the `in` query (max 10 values in Firestore). */
export function lastNameVariants(lastName: string | null | undefined): string[] {
  const t = (lastName ?? '').trim();
  if (!t) return [];
  const title = t.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
  return [...new Set([t, t.toUpperCase(), t.toLowerCase(), title])];
}

function mbiVariants(mbi: string | null | undefined): string[] {
  const raw = (mbi ?? '').trim();
  const n = normalizeMbi(raw);
  if (!n) return [];
  // Stored as typed; also try the canonical 4-3-4 dashed form some faxes use.
  const dashed = n.length === 11 ? `${n.slice(0, 4)}-${n.slice(4, 7)}-${n.slice(7)}` : n;
  return [...new Set([raw, n, dashed])];
}

function displayName(p: Partial<Pick<PatientInput, 'firstName' | 'lastName'>> | null | undefined): string {
  return [p?.lastName?.trim(), p?.firstName?.trim()].filter(Boolean).join(', ') || '(unnamed)';
}

export interface DuplicateQuery {
  patient: Pick<PatientInput, 'lastName' | 'dob' | 'medicareMbi'>;
  /** The referral being checked (never matches itself). */
  referralId?: string | null;
  /** A patient created from this referral (never matches itself). */
  patientId?: string | null;
  now?: Date;
}

export async function findPossibleDuplicates(orgId: string, q: DuplicateQuery): Promise<DuplicateMatch[]> {
  const mbis = mbiVariants(q.patient.medicareMbi);
  const names = q.patient.dob ? lastNameVariants(q.patient.lastName) : [];
  const since = Timestamp.fromMillis((q.now ?? new Date()).getTime() - DUPLICATE_REFERRAL_LOOKBACK_DAYS * 86_400_000);
  const patients = colRef(paths.patients(orgId));
  const referrals = colRef(`orgs/${orgId}/referrals`);

  const [pByMbi, pByName, rByMbi, rByName] = await Promise.all([
    mbis.length ? patients.where('medicareMbi', 'in', mbis).limit(MAX_PER_QUERY).get() : null,
    names.length ? patients.where('lastName', 'in', names).where('dob', '==', q.patient.dob).limit(MAX_PER_QUERY).get() : null,
    mbis.length
      ? referrals.where('extracted.patient.medicareMbi', 'in', mbis).where('createdAt', '>=', since).limit(MAX_PER_QUERY).get()
      : null,
    names.length
      ? referrals.where('extracted.patient.lastName', 'in', names).where('createdAt', '>=', since).limit(MAX_PER_QUERY * 3).get()
      : null,
  ]);

  const out = new Map<string, DuplicateMatch>();
  const add = (kind: DuplicateMatch['kind'], id: string, on: 'mbi' | 'name_dob', name: string, status: string) => {
    if (kind === 'patient' && id === q.patientId) return;
    if (kind === 'referral' && id === q.referralId) return;
    const key = `${kind}/${id}`;
    const cur = out.get(key);
    if (cur) {
      if (!cur.matchedOn.includes(on)) cur.matchedOn.push(on);
    } else {
      out.set(key, { kind, id, matchedOn: [on], displayName: name, status });
    }
  };
  for (const d of pByMbi?.docs ?? []) {
    const p = d.data() as Patient;
    add('patient', d.id, 'mbi', displayName(p), p.status);
  }
  for (const d of pByName?.docs ?? []) {
    const p = d.data() as Patient;
    add('patient', d.id, 'name_dob', displayName(p), p.status);
  }
  const referralMatch = (d: { id: string; data: () => unknown }, on: 'mbi' | 'name_dob') => {
    const r = d.data() as Referral;
    // A referral already turned into a patient is covered by the patient match.
    if (r.status === 'accepted' && r.patientId && out.has(`patient/${r.patientId}`)) return;
    if (r.status === 'rejected') return;
    if (on === 'name_dob' && r.extracted?.patient?.dob !== q.patient.dob) return;
    add('referral', d.id, on, displayName(r.extracted?.patient), r.status);
  };
  for (const d of rByMbi?.docs ?? []) referralMatch(d, 'mbi');
  for (const d of rByName?.docs ?? []) referralMatch(d, 'name_dob');
  return [...out.values()].slice(0, 20);
}
