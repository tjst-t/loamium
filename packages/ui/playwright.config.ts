/**
 * Playwright 設定 (二層テスト — test-discipline 準拠)。
 *
 * - mock プロジェクト (*.mock.spec.ts): page.route で全 API をモックし、
 *   エラー・エッジケースを検証する。sprint run の Story 完了ゲート。
 * - e2e プロジェクト (*.e2e.spec.ts): globalSetup が起動した実サーバー +
 *   実 Vite dev server に対して受け入れ条件 [AC-...] を検証する。
 *
 * ポートはハードコードしない: globalSetup が PORT=0 / 空きポートで起動し、
 * 実際の URL を tests/.harness-state.json 経由でテストへ渡す。
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/harness/global-setup.ts',
  globalTeardown: './tests/harness/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['junit', { outputFile: '../../reports/ui/playwright.xml' }],
  ],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mock', testMatch: /\.mock\.spec\.ts$/ },
    { name: 'e2e', testMatch: /\.e2e\.spec\.ts$/ },
  ],
});
