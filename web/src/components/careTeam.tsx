import { useState } from 'react';
import type { Patient, UpdateCareTeamRequest, UpdateCareTeamResponse } from '@shared/types';
import { useOrgSession } from '../lib/session';
import type { WithId } from '../lib/firestore';
import { useAction } from '../lib/hooks';
import { call } from '../lib/firebase';
import { memberHasCapability } from '../lib/capabilities';
import { Button, ErrorBanner, MemberPicker, Modal } from './ui';

const LICENSED = ['RN', 'NP', 'MD'];

/** Mirrors `updateCareTeam`: admin, `staffing`, or an RN/NP/MD (non-viewer) on the care team. */
export function useCanEditCareTeam(p: Pick<Patient, 'careTeamUids' | 'status'>): boolean {
  const s = useOrgSession();
  if (p.status !== 'admitted' && p.status !== 'referral') return false;
  if (memberHasCapability(s.member, 'staffing') || s.isAdmin) return true;
  return s.role !== 'viewer' && LICENSED.includes(s.member?.discipline ?? '') && (p.careTeamUids ?? []).includes(s.user.uid);
}

/** L1: edit a patient's care team; the patient channel's members follow it (server-side). */
export function CareTeamEditor({ patient, onClose }: { patient: WithId<Patient>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const before = patient.careTeamUids ?? [];
  const [value, setValue] = useState<string[]>(before);
  const add = value.filter((u) => !before.includes(u));
  const remove = before.filter((u) => !value.includes(u));

  async function save() {
    if (add.length + remove.length === 0) return onClose();
    const req: UpdateCareTeamRequest = { orgId: s.orgId, patientId: patient.id };
    if (add.length) req.add = add;
    if (remove.length) req.remove = remove;
    if (await act.run(() => call<UpdateCareTeamRequest, UpdateCareTeamResponse>('updateCareTeam', req))) onClose();
  }

  return (
    <Modal
      title="Edit care team"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={act.busy} onClick={() => void save()}>
            Save{add.length + remove.length ? ` (+${add.length} / −${remove.length})` : ''}
          </Button>
        </>
      }
    >
      <ErrorBanner error={act.error} />
      <p className="muted small">
        Added members join the patient's care-team conversation; removed members leave it. The change is recorded on the patient timeline.
      </p>
      <MemberPicker members={s.members} value={value} onChange={setValue} />
    </Modal>
  );
}

/** "Edit" button for the care-team card; renders nothing when the user may not edit. */
export function CareTeamEditButton({ patient }: { patient: WithId<Patient> }) {
  const can = useCanEditCareTeam(patient);
  const [open, setOpen] = useState(false);
  if (!can) return null;
  return (
    <>
      <Button small onClick={() => setOpen(true)}>Edit</Button>
      {open && <CareTeamEditor patient={patient} onClose={() => setOpen(false)} />}
    </>
  );
}
