import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**', 'lib/**'],
    environment: 'node',
    env: {
      GCLOUD_PROJECT: 'demo-auraconnect',
      FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-auraconnect', storageBucket: 'demo-auraconnect.appspot.com' }),
    },
  },
});
