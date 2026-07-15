import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/tests/unit/**/*.spec.ts',
      'tests/acceptance/**/*.spec.ts',
      'tests/acceptance/**/*.test.ts',
    ],
    reporters: ['default', 'junit'],
    outputFile: {
      junit: 'reports/junit.xml',
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
