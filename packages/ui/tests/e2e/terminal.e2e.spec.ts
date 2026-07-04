/**
 * Story Sb7f458-2 E2E テスト — 実サーバー + 実 Vite + 実シェル (/bin/bash)。
 *
 * ハーネス (global-setup) のサーバーは LOAMIUM_TERMINAL=1 +
 * LOAMIUM_TERMINAL_CMD=/bin/bash で起動しており、WS /api/terminal → node-pty →
 * 実 bash の全経路をブラウザから検証する (test-discipline Rule 2/4: page.route 等の
 * ネットワークモックは使わない)。
 *
 * 無効状態 (AC-Sb7f458-2-2 前半) は LOAMIUM_TERMINAL 未設定の第 2 実サーバー +
 * 第 2 Vite を describe 内で起動して実検証する (1 つのサーバーでは有効/無効を
 * 同時に表現できないため)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');

/** ターミナルタブを開き、シェルのプロンプトが出るまで待つ。 */
async function openTerminal(page: Page): Promise<void> {
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('tab-terminal')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('terminal')).toBeVisible();
  // 実 bash のプロンプト到着 = 接続確立 (xterm は DOM レンダラーなので文字が読める)
  await expect(page.getByTestId('terminal')).toContainText('$', { timeout: 15_000 });
}

/** ターミナルにコマンドを打ち込む (フォーカス → 実キーボード入力)。 */
async function typeCommand(page: Page, command: string): Promise<void> {
  await page.getByTestId('terminal').click();
  await page.keyboard.type(command, { delay: 10 });
  await page.keyboard.press('Enter');
}

test('[AC-Sb7f458-2-1] ターミナルタブで実シェルと対話できる (echo の出力が見える)', async ({
  page,
}) => {
  await openTerminal(page);

  // 計算入りマーカー: 入力エコーではなく実シェルの評価結果を確認する
  await typeCommand(page, 'echo ui-e2e-$((6*7))');
  await expect(page.getByTestId('terminal')).toContainText('ui-e2e-42', { timeout: 10_000 });

  // cwd はハーネスの一時 vault (pty が vault で起動している)
  const vault = readHarnessState().vault;
  await typeCommand(page, 'pwd');
  await expect(page.getByTestId('terminal')).toContainText(path.basename(vault), {
    timeout: 10_000,
  });
});

/** ターミナルに `echo cols=$(tput cols)` を打ち込み、pty が認識している列数を読む。 */
async function readPtyCols(page: Page, marker: string): Promise<number> {
  await typeCommand(page, `echo ${marker}=$(tput cols)`);
  const re = new RegExp(`${marker}=(\\d+)`);
  await expect(page.getByTestId('terminal')).toContainText(re, { timeout: 10_000 });
  const text = await page.getByTestId('terminal').innerText();
  const m = re.exec(text);
  // 取得できないなら resize 検証が成立しないので黙って劣化させずに fail させる
  expect(m, `pty cols (${marker}) を読み取れませんでした`).not.toBeNull();
  return Number(m?.[1]);
}

test('[AC-Sb7f458-2-1] ウィンドウリサイズに追従する (列数が縮小する)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openTerminal(page);

  // 広いビューポートでの列数 (pty が SIGWINCH 経由で認識している値) を必ず取得する
  const colsWide = await readPtyCols(page, 'wide');
  expect(colsWide).toBeGreaterThan(0);

  // ビューポートを狭める → fit addon → resize メッセージ → pty へ SIGWINCH
  await page.setViewportSize({ width: 720, height: 500 });
  const colsNarrow = await readPtyCols(page, 'narrow');

  // リサイズが pty に伝わっていれば列数は必ず縮小する (条件分岐なしで常に検証)
  expect(colsNarrow).toBeGreaterThan(0);
  expect(colsNarrow).toBeLessThan(colsWide);
});

test('[AC-Sb7f458-2-1] タブ切替してもセッションが維持される', async ({ page }) => {
  await openTerminal(page);
  await typeCommand(page, 'echo keep-alive-$((10+13))');
  await expect(page.getByTestId('terminal')).toContainText('keep-alive-23', { timeout: 10_000 });

  // エディタへ切替 → ターミナルは隠れるが unmount されない
  await page.getByTestId('tab-editor').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('terminal')).toBeHidden();

  // 戻ると同じセッション (以前の出力が残っており、続けて対話できる)
  await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('terminal')).toBeVisible();
  await expect(page.getByTestId('terminal')).toContainText('keep-alive-23');
  await typeCommand(page, 'echo still-here-$((2+3))');
  await expect(page.getByTestId('terminal')).toContainText('still-here-5', { timeout: 10_000 });
});

test('[AC-Sb7f458-2-2] シェル終了 (exit) で切断バーが出て、再接続ボタンで新セッションが開く', async ({
  page,
}) => {
  await openTerminal(page);

  await typeCommand(page, 'exit');
  await expect(page.getByTestId('terminal-reconnect-bar')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('terminal-reconnect-bar')).toContainText('切断されました');

  await page.getByTestId('terminal-reconnect').click();
  await expect(page.getByTestId('terminal-reconnect-bar')).toBeHidden({ timeout: 10_000 });
  await typeCommand(page, 'echo reborn-$((5*5))');
  await expect(page.getByTestId('terminal')).toContainText('reborn-25', { timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// 無効状態 — LOAMIUM_TERMINAL 未設定の実サーバー + 実 Vite (モック不使用)
// ---------------------------------------------------------------------------

test.describe('[AC-Sb7f458-2-2] サーバー側で無効な場合の表示 (実サーバー)', () => {
  let vault: string;
  let serverProc: ChildProcess;
  let viteProc: ChildProcess;
  let uiUrl: string;

  function waitForOutput(
    proc: ChildProcess,
    re: RegExp,
    label: string,
    timeoutMs: number,
  ): Promise<RegExpExecArray> {
    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        reject(new Error(`${label} did not start within ${String(timeoutMs)}ms.\n${buf}`));
      }, timeoutMs);
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString();
        const m = re.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m);
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`${label} exited early (code=${String(code)}).\n${buf}`));
      });
    });
  }

  test.beforeAll(async () => {
    vault = await mkdtemp(path.join(tmpdir(), 'loamium-ui-noterm-'));
    // LOAMIUM_TERMINAL を渡さない = デフォルト無効の実サーバー
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LOAMIUM_VAULT: vault,
      LOAMIUM_MODE: 'full',
      PORT: '0',
    };
    delete env.LOAMIUM_TERMINAL;
    delete env.LOAMIUM_TERMINAL_CMD;
    serverProc = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), ['packages/server/src/index.ts'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = await waitForOutput(
      serverProc,
      /listening on http:\/\/127\.0\.0\.1:(\d+)/,
      'loamium server (terminal disabled)',
      20_000,
    );
    const apiUrl = `http://127.0.0.1:${String(m[1])}`;

    // Playwright ワーカーは FORCE_COLOR を設定するため、ANSI カラーで
    // "Local:" 行の正規表現が壊れないよう明示的に無効化する
    const viteEnv: NodeJS.ProcessEnv = { ...process.env, LOAMIUM_API_URL: apiUrl, NO_COLOR: '1' };
    delete viteEnv.FORCE_COLOR;
    viteProc = spawn(path.join(repoRoot, 'node_modules/.bin/vite'), [], {
      cwd: path.join(repoRoot, 'packages/ui'),
      env: viteEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const vm = await waitForOutput(
      viteProc,
      /Local: {3}http:\/\/localhost:(\d+)/,
      'vite dev server (terminal disabled)',
      30_000,
    );
    uiUrl = `http://localhost:${String(vm[1])}`;
  });

  test.afterAll(async () => {
    viteProc.kill('SIGTERM');
    serverProc.kill('SIGTERM');
    await rm(vault, { recursive: true, force: true });
  });

  test('タブに無効の理由と有効化手順 (LOAMIUM_TERMINAL=1) が表示される', async ({ page }) => {
    await page.goto(uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible();
    await page.getByTestId('tab-terminal').click();

    const disabled = page.getByTestId('terminal-disabled');
    await expect(disabled).toBeVisible({ timeout: 10_000 });
    await expect(disabled).toContainText('ターミナルは無効になっています');
    await expect(disabled).toContainText('デフォルト無効');
    await expect(disabled).toContainText('LOAMIUM_TERMINAL=1');
    await expect(disabled).toContainText('LOAMIUM_MODE=full');
    await expect(disabled).toContainText('LOAMIUM_TERMINAL 未設定');
    // xterm ターミナル本体は表示されない (WS 接続も試みない)
    await expect(page.getByTestId('terminal')).toBeHidden();
  });
});
