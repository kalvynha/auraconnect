import { useEffect, useState, type FormEvent } from 'react';
import type { AcceptInviteRequest, AcceptInviteResponse, CreateOrgRequest, CreateOrgResponse, Discipline, Role } from '@shared/types';
import { call } from '../lib/firebase';
import { DISCIPLINES, TIMEZONES } from '../lib/constants';
import { errorMessage } from '../lib/format';
import { useSession } from '../lib/session';
import { Badge, Button, Card, ErrorBanner, Field, Loading } from '../components/ui';

interface MyInvite {
  orgId: string;
  inviteId: string;
  orgName: string;
  role: Role;
}

export default function OnboardingPage() {
  const s = useSession();
  const [invites, setInvites] = useState<MyInvite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const guessTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(TIMEZONES.includes(guessTz) ? guessTz : 'America/New_York');
  const [displayName, setDisplayName] = useState(s.user?.displayName ?? '');
  const [discipline, setDiscipline] = useState<Discipline>('Admin');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    call<Record<string, never>, { invites: MyInvite[] }>('listMyInvites', {})
      .then((r) => setInvites(r.invites))
      .catch((err) => {
        setInvites([]);
        setError(errorMessage(err));
      });
  }, []);

  async function finish() {
    await s.user?.getIdToken(true);
    await s.reload();
  }

  async function accept(inv: MyInvite) {
    setBusyId(inv.inviteId);
    setError(null);
    try {
      await call<AcceptInviteRequest, AcceptInviteResponse>('acceptInvite', { orgId: inv.orgId, inviteId: inv.inviteId });
      await finish();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function createOrg(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await call<CreateOrgRequest, CreateOrgResponse>('createOrg', {
        name: name.trim(),
        timezone,
        displayName: displayName.trim(),
        discipline,
      });
      await finish();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  const tzOptions = TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES];

  return (
    <div className="onboarding">
      <div className="row space-between">
        <h1>Welcome to AuraConnect</h1>
        <Button variant="ghost" onClick={() => void s.signOut()}>Sign out</Button>
      </div>
      <p className="muted">Signed in as {s.user?.email}. Join an organization you've been invited to, or create a new one.</p>
      <ErrorBanner error={error} />
      <div className="grid-2">
        <Card title="Pending invitations">
          {invites === null ? (
            <Loading />
          ) : invites.length === 0 ? (
            <p className="muted">No pending invitations for {s.user?.email}.</p>
          ) : (
            <ul className="list">
              {invites.map((inv) => (
                <li key={inv.inviteId} className="list-row">
                  <div>
                    <strong>{inv.orgName}</strong> <Badge value={inv.role} />
                  </div>
                  <Button variant="primary" small busy={busyId === inv.inviteId} onClick={() => void accept(inv)}>
                    Accept
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Create a new organization">
          <form className="form" onSubmit={createOrg}>
            <Field label="Organization name">
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Time zone" hint="Used for daily deadline checks.">
              <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {tzOptions.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </Field>
            <Field label="Your display name">
              <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label="Your discipline">
              <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)}>
                {DISCIPLINES.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="primary" busy={creating}>Create organization</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
