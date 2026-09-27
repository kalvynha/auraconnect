/**
 * firebase-admin, loaded from `functions/node_modules` so the harness and the
 * handlers under test share ONE module instance (same default app, same
 * Firestore client, same prototypes to instrument). This package deliberately
 * does not depend on firebase-admin itself.
 */
export { initializeApp, getApps } from '../../../functions/node_modules/firebase-admin/lib/app/index.js';
export { getAuth } from '../../../functions/node_modules/firebase-admin/lib/auth/index.js';
export {
  getFirestore,
  FieldValue,
  Timestamp,
  type DocumentReference,
  type Firestore,
} from '../../../functions/node_modules/firebase-admin/lib/firestore/index.js';
export { getMessaging } from '../../../functions/node_modules/firebase-admin/lib/messaging/index.js';
export { getFunctions } from '../../../functions/node_modules/firebase-admin/lib/functions/index.js';

/** Root of the @google-cloud/firestore build used by firebase-admin (for read/write counting). */
export const GCF_FIRESTORE_SRC = '../../../functions/node_modules/@google-cloud/firestore/build/src';
