import { orderBy, query, where } from 'firebase/firestore';
import type { Patient, PatientStatus } from '@shared/types';
import { orgCol } from './firestore';
import { useLiveQuery } from './hooks';

/** Live patients, optionally restricted to some statuses (single-field query; no composite index). */
export function usePatients(orgId: string, statuses?: PatientStatus[]) {
  const key = statuses?.join(',') ?? '*';
  return useLiveQuery<Patient>(
    statuses && statuses.length
      ? query(orgCol(orgId, 'patients'), where('status', 'in', statuses))
      : query(orgCol(orgId, 'patients'), orderBy('lastName')),
    [orgId, key],
  );
}
