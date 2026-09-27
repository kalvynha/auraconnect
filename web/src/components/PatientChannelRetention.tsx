import { useEffect, useState, type FormEvent } from 'react';
import { deleteField, updateDoc } from 'firebase/firestore';
import { useOrgSession } from '../lib/session';
import { orgDoc } from '../lib/firestore';
import { useAction } from '../lib/hooks';
import { Button, ErrorBanner, Field } from './ui';

/** Mirrors firestore.rules and `purgeExpiredMessages` (6 to 100 years). */
export const MIN_PATIENT_RETENTION_DAYS = 2190;
export const MAX_PATIENT_RETENTION_DAYS = 36500;

/**
 * S6: retention for patient care-team channels. They are never purged unless this is set to at least
 * 6 years (`org.patientChannelRetentionDays`); the general message lifespan does not apply to them.
 */
export function PatientChannelRetentionField() {
  const s = useOrgSession();
  const act = useAction();
  const current = s.org?.patientChannelRetentionDays ?? null;
  const [keep, setKeep] = useState(current === null);
  const [days, setDays] = useState(String(current ?? MIN_PATIENT_RETENTION_DAYS));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setKeep(current === null);
    setDays(String(current ?? MIN_PATIENT_RETENTION_DAYS));
  }, [current]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const next = keep ? null : Number(days);
    if (next !== null && (!Number.isInteger(next) || next < MIN_PATIENT_RETENTION_DAYS || next > MAX_PATIENT_RETENTION_DAYS)) {
      return act.setError(`Patient channel retention must be ${MIN_PATIENT_RETENTION_DAYS}–${MAX_PATIENT_RETENTION_DAYS} days (6–100 years), or keep forever.`);
    }
    if (next === current) return setSaved(true);
    if (
      next !== null &&
      !window.confirm(
        `Patient care-team messages older than ${next} days (${(next / 365).toFixed(1)} years) and their attachments will be permanently deleted every day. ` +
          'These conversations can be part of the clinical record: confirm this matches your records-retention policy and any state law. Continue?',
      )
    ) {
      return;
    }
    if (await act.run(() => updateDoc(orgDoc(s.orgId), { patientChannelRetentionDays: next === null ? deleteField() : next }))) setSaved(true);
  }

  return (
    <form className="form form-narrow" onSubmit={save}>
      <ErrorBanner error={act.error} />
      {saved && <div className="banner banner-ok">Patient channel retention saved.</div>}
      <Field
        label="Patient channel retention"
        hint="Patient care-team channels are kept forever unless set here (at least 6 years). The message retention above never applies to them; channels on legal hold are never purged."
      >
        <label className="row gap-sm">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep patient channels forever
        </label>
        {!keep && (
          <>
            <input
              type="number"
              min={MIN_PATIENT_RETENTION_DAYS}
              max={MAX_PATIENT_RETENTION_DAYS}
              step={1}
              required
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            <div className="banner banner-warn small">
              Deletion is permanent. Patient conversations may be part of the medical record; check your retention policy first.
            </div>
          </>
        )}
      </Field>
      <div>
        <Button type="submit" busy={act.busy}>Save patient channel retention</Button>
      </div>
    </form>
  );
}
