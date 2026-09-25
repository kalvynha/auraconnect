import { useEffect, useState } from 'react';
import { onSnapshot, type DocumentData, type DocumentReference, type Query } from 'firebase/firestore';
import { fromSnap, type WithId } from './firestore';
import { errorMessage } from './format';

export interface LiveResult<T> {
  data: T;
  loading: boolean;
  error: string | null;
}

/**
 * Subscribe to a query. `q` should be memoized (or pass `deps`) so the listener
 * isn't recreated every render. Pass null to skip.
 */
export function useLiveQuery<T>(q: Query<DocumentData> | null, deps: unknown[]): LiveResult<WithId<T>[]> {
  const [state, setState] = useState<LiveResult<WithId<T>[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    if (!q) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => fromSnap<T>(d)), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: errorMessage(err) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function useLiveDoc<T>(ref: DocumentReference<DocumentData> | null, deps: unknown[]): LiveResult<WithId<T> | null> {
  const [state, setState] = useState<LiveResult<WithId<T> | null>>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!ref) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    return onSnapshot(
      ref,
      (snap) => setState({ data: snap.exists() ? fromSnap<T>(snap) : null, loading: false, error: null }),
      (err) => setState({ data: null, loading: false, error: errorMessage(err) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
