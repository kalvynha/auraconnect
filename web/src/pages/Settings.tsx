import { useEffect, useState, type FormEvent } from 'react';
import { orderBy, query, updateDoc } from 'firebase/firestore';
import type { MilestoneKind, OnCallRole, Org } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc } from '../lib/firestore';
import { useAction, useLiveQuery } from '../lib/hooks';
import { ORG_SETTING_DEFAULTS, TIMEZONES, orgSettings } from '../lib/constants';
import { Button, Card, ErrorBanner, Field, Page } from '../components/ui';
import { DEADLINE_LEAD_DAYS_DEFAULTS } from '../lib/lifecycle';
import { BereavementSettingsCard } from './Bereavement';
import { PatientChannelRetentionField } from '../components/PatientChannelRetention';
import { MissedVisitAlertCard } from '../components/visits';

type SettingsPatch = Partial<Pick<Org, 'triageRoleKey' | 'idgCadenceDays' | 'missedVisitGraceMinutes' | 'messageLifespanDays'>>;
type OrgPatch = Partial<Pick<Org, 'name' | 'timezone' | 'deadlineLeadDays' | 'deadlineLeadDaysByKind'>>;

/** V1: per-kind reminder lead times shown in settings. HOPE sets all three HOPE kinds. */
type LeadGroup = 'noe' | 'recert' | 'f2f' | 'hope';
const LEAD_GROUPS: { key: LeadGroup; label: string; kinds: MilestoneKind[] }[] = [
  { key: 'noe', label: 'NOE', kinds: ['noe'] },
  { key: 'recert', label: 'Recertification', kinds: ['recert'] },
  { key: 'f2f', label: 'Face-to-face', kinds: ['f2f'] },
  { key: 'hope', label: 'HOPE (admission, HUV1, HUV2)', kinds: ['hope_admission', 'hope_huv1', 'hope_huv2'] },
];

function leadDraft(org: Partial<Org> | null | undefined): Record<LeadGroup, string> {
  const by = org?.deadlineLeadDaysByKind ?? {};
  const out = {} as Record<LeadGroup, string>;
  for (const g of LEAD_GROUPS) out[g.key] = String(by[g.kinds[0]!] ?? DEADLINE_LEAD_DAYS_DEFAULTS[g.kinds[0]!]);
  return out;
}

/**
 * Organization name, time zone and deadline lead time. firestore.rules (orgs/{orgId} update, admin)
 * require: name non-empty string ≤ 200, timezone non-empty string ≤ 64, deadlineLeadDays int 0–90.
 */
function OrgSettingsCard() {
  const s = useOrgSession();
  const act = useAction();
  const [name, setName] = useState(s.org?.name ?? '');
  const [timezone, setTimezone] = useState(s.org?.timezone ?? '');
  const [leadDays, setLeadDays] = useState(String(s.org?.deadlineLeadDays ?? 7));
  const [byKind, setByKind] = useState<Record<LeadGroup, string>>(leadDraft(s.org));
  const [saved, setSaved] = useState(false);
  const byKindJson = JSON.stringify(s.org?.deadlineLeadDaysByKind ?? null);

  useEffect(() => {
    setName(s.org?.name ?? '');
    setTimezone(s.org?.timezone ?? '');
    setLeadDays(String(s.org?.deadlineLeadDays ?? 7));
    setByKind(leadDraft(s.org));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.org?.name, s.org?.timezone, s.org?.deadlineLeadDays, byKindJson]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const n = name.trim();
    const lead = Number(leadDays);
    if (!n || n.length > 200) return act.setError('Organization name is required (up to 200 characters).');
    if (!timezone || timezone.length > 64) return act.setError('Choose a time zone.');
    if (!Number.isInteger(lead) || lead < 0 || lead > 90) return act.setError('Deadline lead time must be a whole number of days from 0 to 90.');
    const patch: OrgPatch = {};
    if (n !== s.org?.name) patch.name = n;
    if (timezone !== s.org?.timezone) {
      if (!window.confirm(`Change the organization time zone to ${timezone}? Deadline checks, nightly metrics and "today" on the server will use it.`)) return;
      patch.timezone = timezone;
    }
    if (lead !== s.org?.deadlineLeadDays) patch.deadlineLeadDays = lead;
    const nextByKind: Partial<Record<MilestoneKind, number>> = { ...(s.org?.deadlineLeadDaysByKind ?? {}) };
    for (const g of LEAD_GROUPS) {
      const v = Number(byKind[g.key]);
      if (!Number.isInteger(v) || v < 0 || v > 90) return act.setError(`${g.label} lead time must be a whole number of days from 0 to 90.`);
      for (const k of g.kinds) nextByKind[k] = v;
    }
    if (JSON.stringify(nextByKind) !== JSON.stringify(s.org?.deadlineLeadDaysByKind ?? {})) patch.deadlineLeadDaysByKind = nextByKind;
    if (Object.keys(patch).length === 0) return setSaved(true);
    if (await act.run(() => updateDoc(orgDoc(s.orgId), patch))) setSaved(true);
  }

  const tzOptions = timezone && !TIMEZONES.includes(timezone) ? [timezone, ...TIMEZONES] : TIMEZONES;

  return (
    <Card title="Organization">
      <form className="form form-narrow" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        {saved && <div className="banner banner-ok">Organization settings saved.</div>}
        <Field label="Organization name">
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Time zone" hint="Used for deadline checks, missed visits and nightly metrics.">
          <select required value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            <option value="" disabled>Select time zone…</option>
            {tzOptions.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </Field>
        <fieldset className="fieldset">
          <legend>Deadline reminder lead time (days before due)</legend>
          <p className="muted small">
            A normal, non-escalating reminder goes to the care team's RNs, NPs and MDs (admins if there are none) this many days before
            the deadline. Overdue deadlines raise a separate urgent alert that escalates.
          </p>
          <div className="form-grid">
            {LEAD_GROUPS.map((g) => (
              <Field key={g.key} label={g.label} hint={`0–90. Default ${DEADLINE_LEAD_DAYS_DEFAULTS[g.kinds[0]!]}.`}>
                <input type="number" min={0} max={90} step={1} required value={byKind[g.key]} onChange={(e) => setByKind({ ...byKind, [g.key]: e.target.value })} />
              </Field>
            ))}
          </div>
          <Field label="Other deadlines" hint="0–90. Used for any milestone kind without its own lead time.">
            <input type="number" min={0} max={90} step={1} required value={leadDays} onChange={(e) => setLeadDays(e.target.value)} />
          </Field>
        </fieldset>
        <div>
          <Button type="submit" variant="primary" busy={act.busy}>Save organization</Button>
        </div>
      </form>
    </Card>
  );
}

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
      <OrgSettingsCard />
      <BereavementSettingsCard />
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
        <PatientChannelRetentionField />
      </Card>
      <MissedVisitAlertCard />
    </Page>
  );
}
