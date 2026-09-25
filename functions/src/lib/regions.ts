import { defineString } from 'firebase-functions/params';

/**
 * Event-triggered functions must run in the same region as the resource they
 * listen to. Callables, the scheduler and task queues stay in us-central1.
 *
 * Firestore multi-region `nam5` → `us-central1`; a regional database uses its own region.
 * `scripts/gcp-setup.sh` detects both locations and writes them to `functions/.env.<projectId>`.
 */
export const FIRESTORE_TRIGGER_REGION = defineString('FIRESTORE_TRIGGER_REGION', {
  default: 'us-central1',
  description: 'Region of the Firestore database (nam5 → us-central1).',
});

export const STORAGE_TRIGGER_REGION = defineString('STORAGE_TRIGGER_REGION', {
  default: 'us-central1',
  description: 'Region of the default Cloud Storage bucket, lower-case (e.g. us-west1).',
});
