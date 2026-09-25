import {
  collection,
  doc,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from './firebase';

/** A Firestore document with its id merged in. */
export type WithId<T> = T & { id: string };

export function fromSnap<T>(snap: QueryDocumentSnapshot<DocumentData> | DocumentSnapshot<DocumentData>): WithId<T> {
  return { id: snap.id, ...(snap.data({ serverTimestamps: 'estimate' }) as T) };
}

export function orgCol(orgId: string, ...path: string[]): CollectionReference<DocumentData> {
  return collection(db, 'orgs', orgId, ...path);
}

export function orgDoc(orgId: string, ...path: string[]): DocumentReference<DocumentData> {
  return doc(db, 'orgs', orgId, ...(path as [string, ...string[]]));
}
