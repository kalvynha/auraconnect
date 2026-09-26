import { useState, type ReactNode } from 'react';
import { isSignInWithEmailLink } from 'firebase/auth';
import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import type { Role } from '@shared/types';
import { useSession } from './lib/session';
import { auth } from './lib/firebase';
import { FINISH_SIGN_IN_PATH } from './lib/invites';
import FinishSignInPage from './pages/FinishSignIn';
import { INTAKE_ROLES } from './lib/constants';
import { Badge, Button, ErrorBanner, Loading } from './components/ui';
import SignInPage from './pages/SignIn';
import OnboardingPage from './pages/Onboarding';
import DashboardPage from './pages/Dashboard';
import MembersPage from './pages/Members';
import TeamsPage from './pages/Teams';
import SchedulePage from './pages/Schedule';
import PoliciesPage from './pages/Policies';
import PatientsPage from './pages/Patients';
import PatientDetailPage from './pages/PatientDetail';
import AdmitWizardPage from './pages/AdmitWizard';
import ReferralsPage from './pages/Referrals';
import ReferralReviewPage from './pages/ReferralReview';
import AlertsPage from './pages/Alerts';
import AuditLogPage from './pages/AuditLog';
import MessagesPage from './pages/Messages';

interface NavItem {
  to: string;
  label: string;
  roles?: readonly Role[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/messages', label: 'Messages' },
  { to: '/alerts', label: 'Alerts' },
  { to: '/patients', label: 'Patients' },
  { to: '/referrals', label: 'Referrals', roles: INTAKE_ROLES },
  { to: '/schedule', label: 'On-call schedule' },
  { to: '/members', label: 'Members', roles: ['admin'] },
  { to: '/teams', label: 'Teams', roles: ['admin'] },
  { to: '/policies', label: 'Escalation policies', roles: ['admin'] },
  { to: '/audit', label: 'Audit log', roles: ['admin'] },
];

function Layout() {
  const s = useSession();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <div className="brand-name">AuraConnect</div>
            <div className="brand-org">{s.org?.name ?? ''}</div>
          </div>
        </div>
        <nav>
          {NAV.filter((n) => !n.roles || (s.role && n.roles.includes(s.role))).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="who">
            <div className="who-name">{s.member?.displayName ?? s.user?.email}</div>
            <div className="row gap-sm">
              {s.role && <Badge value={s.role} />}
              {s.member?.discipline && <span className="muted small">{s.member.discipline}</span>}
            </div>
          </div>
          <Button small variant="ghost" onClick={() => void s.signOut()}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="main">
        {s.member && !s.member.active && (
          <div className="banner banner-error">Your membership is inactive. Contact an administrator.</div>
        )}
        <Outlet />
      </main>
    </div>
  );
}

function RequireRole({ roles, children }: { roles: readonly Role[]; children: ReactNode }) {
  const { role } = useSession();
  if (!role || !roles.includes(role)) {
    return (
      <div className="page">
        <h1>Not authorized</h1>
        <p className="muted">You don't have access to this page.</p>
      </div>
    );
  }
  return <>{children}</>;
}

const ADMIN: readonly Role[] = ['admin'];

export default function App() {
  const s = useSession();
  const [emailLink, setEmailLink] = useState(
    () => window.location.pathname === FINISH_SIGN_IN_PATH && isSignInWithEmailLink(auth, window.location.href),
  );

  if (emailLink) {
    return (
      <FinishSignInPage
        onDone={() => {
          setEmailLink(false);
          void s.reload();
        }}
      />
    );
  }
  if (s.status === 'loading') return <div className="center-screen"><Loading /></div>;
  if (s.status === 'signedOut') return <SignInPage />;
  if (s.status === 'onboarding') return <OnboardingPage />;
  if (s.status === 'error') {
    return (
      <div className="center-screen">
        <div className="auth-card">
          <h1>Couldn't load your workspace</h1>
          <ErrorBanner error={s.error} />
          <div className="row gap">
            <Button variant="primary" onClick={() => void s.reload()}>Retry</Button>
            <Button onClick={() => void s.signOut()}>Sign out</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="messages/:channelId" element={<MessagesPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="patients" element={<PatientsPage />} />
        <Route path="patients/new" element={<RequireRole roles={INTAKE_ROLES}><AdmitWizardPage /></RequireRole>} />
        <Route path="patients/:patientId" element={<PatientDetailPage />} />
        <Route path="patients/:patientId/admit" element={<RequireRole roles={INTAKE_ROLES}><AdmitWizardPage /></RequireRole>} />
        <Route path="referrals" element={<RequireRole roles={INTAKE_ROLES}><ReferralsPage /></RequireRole>} />
        <Route path="referrals/:referralId" element={<RequireRole roles={INTAKE_ROLES}><ReferralReviewPage /></RequireRole>} />
        <Route path="schedule" element={<SchedulePage />} />
        <Route path="members" element={<RequireRole roles={ADMIN}><MembersPage /></RequireRole>} />
        <Route path="teams" element={<RequireRole roles={ADMIN}><TeamsPage /></RequireRole>} />
        <Route path="policies" element={<RequireRole roles={ADMIN}><PoliciesPage /></RequireRole>} />
        <Route path="audit" element={<RequireRole roles={ADMIN}><AuditLogPage /></RequireRole>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
