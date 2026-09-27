/**
 * Audits org settings changes (S6): any update to `orgs/{orgId}` writes an
 * `org.settings_update` entry listing the changed keys with their old and new
 * values. Settings are configuration, not PHI. The actor is the signed-in user
 * who wrote the doc (admins edit settings directly), or `system`.
 */
import { onDocumentUpdatedWithAuthContext } from 'firebase-functions/v2/firestore';
import { writeAudit } from '../lib/audit';
import { FIRESTORE_TRIGGER_REGION } from '../lib/regions';

/** Keys never reported (server-maintained bookkeeping). */
const IGNORED_KEYS = new Set(['updatedAt']);

function norm(v: unknown): unknown {
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    return new Date((v as { toMillis: () => number }).toMillis()).toISOString();
  }
  return v ?? null;
}

/** Changed top-level keys between two org docs, with `{from, to}` values. */
export function diffOrgSettings(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED_KEYS.has(k)) continue;
    const a = norm(before[k]);
    const b = norm(after[k]);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
}

export async function handleOrgUpdated(orgId: string, before: Record<string, unknown>, after: Record<string, unknown>, actorUid: string): Promise<boolean> {
  const changes = diffOrgSettings(before, after);
  const fields = Object.keys(changes).sort();
  if (fields.length === 0) return false;
  await writeAudit(orgId, { actorUid, action: 'org.settings_update', resourceType: 'org', resourceId: orgId, metadata: { fields, changes } });
  return true;
}

export const onOrgSettingsUpdated = onDocumentUpdatedWithAuthContext({ document: 'orgs/{orgId}', region: FIRESTORE_TRIGGER_REGION }, async (event) => {
  if (!event.data) return;
  const actor = event.authId && event.authType !== 'service_account' && event.authType !== 'system' ? event.authId : 'system';
  await handleOrgUpdated(event.params.orgId, event.data.before.data() ?? {}, event.data.after.data() ?? {}, actor);
});
