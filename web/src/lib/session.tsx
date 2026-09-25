import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { doc, getDoc, onSnapshot, orderBy, query } from 'firebase/firestore';
import type { Member, Org, Role, UserOrg } from '@shared/types';
import { auth, db } from './firebase';
import { fromSnap, orgCol, orgDoc, type WithId } from './firestore';
import { errorMessage } from './format';

export type SessionStatus = 'loading' | 'signedOut' | 'onboarding' | 'ready' | 'error';

interface SessionState {
  status: SessionStatus;
  user: User | null;
  orgId: string | null;
  role: Role | null;
  member: WithId<Member> | null;
  org: WithId<Org> | null;
  /** All members of the org (live), sorted by display name. */
  members: WithId<Member>[];
  error: string | null;
}

export interface Session extends SessionState {
  isAdmin: boolean;
  /** Re-read userOrgs/{uid} (force-refreshing the ID token first). */
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  memberName: (uid: string | null | undefined) => string;
}

const SessionContext = createContext<Session | null>(null);

const initial: SessionState = {
  status: 'loading',
  user: null,
  orgId: null,
  role: null,
  member: null,
  org: null,
  members: [],
  error: null,
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(initial);
  const [user, setUser] = useState<User | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [userOrg, setUserOrg] = useState<UserOrg | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        setAuthResolved(true);
      }),
    [],
  );

  // Resolve the user's org from userOrgs/{uid}; make sure the ID token carries matching claims.
  useEffect(() => {
    if (!authResolved) return;
    if (!user) {
      setUserOrg(null);
      setState({ ...initial, status: 'signedOut' });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: 'loading', user, error: null }));
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'userOrgs', user.uid));
        if (cancelled) return;
        if (!snap.exists()) {
          setUserOrg(null);
          setState({ ...initial, status: 'onboarding', user });
          return;
        }
        const uo = snap.data() as UserOrg;
        // If claims are stale (e.g. just joined, or role changed), refresh the token.
        const token = await user.getIdTokenResult();
        if (token.claims.orgId !== uo.orgId || token.claims.role !== uo.role) {
          await user.getIdToken(true);
        }
        if (cancelled) return;
        setUserOrg(uo);
      } catch (err) {
        if (!cancelled) setState({ ...initial, status: 'error', user, error: errorMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authResolved, user, reloadKey]);

  // Live subscriptions to org, own member doc and the member roster.
  useEffect(() => {
    if (!user || !userOrg) return;
    const orgId = userOrg.orgId;
    let gotMember = false;
    let gotOrg = false;
    let gotMembers = false;
    const markReady = () => {
      if (gotMember && gotOrg && gotMembers) setState((s) => ({ ...s, status: 'ready' }));
    };
    setState((s) => ({ ...s, user, orgId, role: userOrg.role }));
    const onErr = (err: unknown) => {
      const denied = (err as { code?: string } | null)?.code === 'permission-denied';
      setState((s) => ({
        ...s,
        status: 'error',
        error: denied
          ? 'Access denied. Your membership may be inactive, or your permissions are still being set up — try again in a moment.'
          : errorMessage(err),
      }));
    };

    const unsubs = [
      onSnapshot(
        orgDoc(orgId, 'members', user.uid),
        (snap) => {
          const member = snap.exists() ? fromSnap<Member>(snap) : null;
          setState((s) => ({ ...s, member, role: member?.role ?? userOrg.role }));
          gotMember = true;
          markReady();
        },
        onErr,
      ),
      onSnapshot(
        doc(db, 'orgs', orgId),
        (snap) => {
          setState((s) => ({ ...s, org: snap.exists() ? fromSnap<Org>(snap) : null }));
          gotOrg = true;
          markReady();
        },
        onErr,
      ),
      onSnapshot(
        query(orgCol(orgId, 'members'), orderBy('displayName')),
        (snap) => {
          setState((s) => ({ ...s, members: snap.docs.map((d) => fromSnap<Member>(d)) }));
          gotMembers = true;
          markReady();
        },
        onErr,
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [user, userOrg]);

  const reload = useCallback(async () => {
    if (auth.currentUser) await auth.currentUser.getIdToken(true);
    setReloadKey((k) => k + 1);
  }, []);

  const doSignOut = useCallback(async () => {
    await signOut(auth);
  }, []);

  const session = useMemo<Session>(() => {
    const byUid = new Map(state.members.map((m) => [m.uid ?? m.id, m]));
    return {
      ...state,
      isAdmin: state.role === 'admin',
      reload,
      signOut: doSignOut,
      memberName: (uid) => {
        if (!uid) return '—';
        const m = byUid.get(uid);
        return m ? m.displayName || m.email : 'Unknown member';
      },
    };
  }, [state, reload, doSignOut]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession must be used within SessionProvider');
  return s;
}

/** Session narrowed to a ready, org-scoped state (use inside guarded routes). */
export interface OrgSession extends Session {
  user: User;
  orgId: string;
  role: Role;
}

export function useOrgSession(): OrgSession {
  const s = useSession();
  if (!s.user || !s.orgId || !s.role) throw new Error('No org session');
  return s as OrgSession;
}
