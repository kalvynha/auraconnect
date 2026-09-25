import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // All files share one emulator instance and clear it between tests.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
