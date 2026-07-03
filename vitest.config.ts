import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'tests/acceptance/**/*.spec.ts',
    ],
    reporters: ['default', 'junit'],
    outputFile: {
      junit: 'reports/junit.xml',
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
