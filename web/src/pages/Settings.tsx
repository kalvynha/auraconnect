import { useEffect, useState, type FormEvent } from 'react';
import { orderBy, query, updateDoc } from 'firebase/firestore';
import type { OnCallRole, Org } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc } from '../lib/firestore';
import { useAction, useLiveQuery } from '../lib/hooks';
import { ORG_SETTING_DEFAULTS, orgSettings } from '../lib/constants';
import { Button, Card, ErrorBanner, Field, Page } from '../components/ui';

type SettingsPatch = Partial<Pick<Org, 'triageRoleKey' | 'idgCadenceDays' | 'missedVisitGraceMinutes' | 'messageLifespanDays'>>;

export default function SettingsPage() {
  const s = useOrgSession();
  const act = useAction();
  const roles = useLiveQuery<OnCallRole>(query(orgCol(s.orgId, 'onCallRoles'), orderBy('label')), [s.orgId]);
  const current = orgSettings(s.org);
  const [triageRoleKey, setTriage] = useState(current.triageRoleKey ?? '');
  const [idgCadenceDays, setCadence] = useState(String(current.idgCadenceDays));
  const [grace, setGrace] = useState(String(current.missedVisitGraceMinutes));
  const [keepForever, setKeepForever] = useState(current.messageLifespanDays === null);
  const [lifespan, setLifespan] = useState(String(current.messageLifespanDays ?? 365));
  const [saved, setSaved] = useState(false);

  // Reset the form when the org doc changes elsewhere.
  useEffect(() => {
    const c = orgSettings(s.org);
    setTriage(c.triageRoleKey ?? '');
    setCadence(String(c.idgCadenceDays));
    setGrace(String(c.missedVisitGraceMinutes));
    setKeepForever(c.messageLifespanDays === null);
    setLifespan(String(c.messageLifespanDays ?? 365));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.org?.triageRoleKey, s.org?.idgCadenceDays, s.org?.missedVisitGraceMinutes, s.org?.messageLifespanDays]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const cadence = Number(idgCadenceDays);
    const g = Number(grace);
    const life = keepForever ? null : Number(lifespan);
    if (!Number.isInteger(cadence) || cadence < 1 || cadence > 30) return act.setError('IDG cadence must be a whole number of days from 1 to 30.');
    if (!Number.isInteger(g) || g < 15 || g > 1440) return act.setError('Missed-visit grace must be 15–1440 minutes.');
    if (life !== null && (!Number.isInteger(life) || life < 7 || life > 3650)) return act.setError('Message lifespan must be 7–3650 days, or keep forever.');
    if (life !== null && current.messageLifespanDays !== life) {
      if (!window.confirm(`Messages older than ${life} days (and their attachments) will be permanently deleted every day. Continue?`)) return;
    }
    // Only send changed keys (admins may update exactly these org fields).
    const patch: SettingsPatch = {};
    const tk = triageRoleKey || null;
    if (tk !== (s.org?.triageRoleKey ?? null) || s.org?.triageRoleKey === undefined) patch.triageRoleKey = tk;
    if (cadence !== s.org?.idgCadenceDays) patch.idgCadenceDays = cadence;
    if (g !== s.org?.missedVisitGraceMinutes) patch.missedVisitGraceMinutes = g;
    if (life !== (s.org?.messageLifespanDays ?? null) || s.org?.messageLifespanDays === undefined) patch.messageLifespanDays = life;
    if (Object.keys(patch).length === 0) return setSaved(true);
    if (await act.run(() => updateDoc(orgDoc(s.orgId), patch))) setSaved(true);
  }

  return (
    <Page title="Settings">
      <Card title="Care coordination settings">
        <form className="form form-narrow" onSubmit={submit}>
          <ErrorBanner error={act.error ?? roles.error} />
          {saved && <div className="banner banner-ok">Settings saved.</div>}
          <Field label="Default triage role" hint="After-hours calls route to whoever holds this on-call role, unless the caller picks another.">
            <select value={triageRoleKey} onChange={(e) => setTriage(e.target.value)}>
              <option value="">None (caller chooses)</option>
              {roles.data.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              {triageRoleKey && !roles.data.some((r) => r.id === triageRoleKey) && <option value={triageRoleKey}>{triageRoleKey} (missing)</option>}
            </select>
          </Field>
          <Field label="IDG review cadence (days)" hint={`1–30. CMS requires review at least every 15 days. Default ${ORG_SETTING_DEFAULTS.idgCadenceDays}.`}>
            <input type="number" min={1} max={30} step={1} required value={idgCadenceDays} onChange={(e) => setCadence(e.target.value)} />
          </Field>
          <Field label="Missed-visit grace (minutes)" hint={`15–1440. A scheduled visit becomes missed this long after it ends. Default ${ORG_SETTING_DEFAULTS.missedVisitGraceMinutes}.`}>
            <input type="number" min={15} max={1440} step={1} required value={grace} onChange={(e) => setGrace(e.target.value)} />
          </Field>
          <Field label="Message retention" hint="When set, older messages and attachments are purged daily (7–3650 days).">
            <label className="row gap-sm">
              <input type="checkbox" checked={keepForever} onChange={(e) => setKeepForever(e.target.checked)} /> Keep messages forever
            </label>
            {!keepForever && (
              <input type="number" min={7} max={3650} step={1} required value={lifespan} onChange={(e) => setLifespan(e.target.value)} />
            )}
          </Field>
          <div>
            <Button type="submit" variant="primary" busy={act.busy}>Save settings</Button>
          </div>
        </form>
      </Card>
    </Page>
  );
}
