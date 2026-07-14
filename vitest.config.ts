import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // worktree 内の packages/shared を優先的に参照する (main repo の node_modules を上書き)
      '@loamium/shared': path.resolve('./packages/shared/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/tests/unit/**/*.spec.ts',
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
