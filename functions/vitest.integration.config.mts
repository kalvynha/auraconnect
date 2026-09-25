import { defineConfig } from 'vitest/config';

/**
 * Emulator integration tests. Run from the repo root with:
 *   npx firebase-tools emulators:exec --only firestore,auth "npm --prefix functions run test:integration"
 * Requires FIRESTORE_EMULATOR_HOST (and FIREBASE_AUTH_EMULATOR_HOST for claim tests).
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
