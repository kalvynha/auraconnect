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

/**
 * Busy/error state around an async action (usually a callable). `run` resolves to true on success.
 * Errors are shown to the user, never logged (they may echo PHI back from the server).
 */
export function useAction(): { busy: boolean; error: string | null; setError: (e: string | null) => void; run: (fn: () => Promise<unknown>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}
