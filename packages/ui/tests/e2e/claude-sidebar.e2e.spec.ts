/**
 * Story Sf1a90a-2 E2E — 右サイドバーの Claude トグル (実サーバー + 実 Vite + 実シェル)。
 *
 * ハーネス (global-setup) のサーバーは LOAMIUM_TERMINAL=1 +
 * LOAMIUM_TERMINAL_CMD=/bin/bash で起動しており、右サイドバーの Claude ペイン
 * → WS /api/terminal → node-pty → 実 bash の全経路をブラウザから双方向 I/O で検証する
 * (test-discipline Rule 2/4/7: page.route 等のモックは使わず本番モードの実シェル)。
 * 既定コマンド claude 自体はログイン依存の外部要件のため手動 smoke + README で担保する。
 *
 * 無効状態 (AC-Sf1a90a-2-2 後半) は LOAMIUM_TERMINAL 未設定の第 2 実サーバー +
 * 第 2 Vite を describe 内で起動して実検証する。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');

/** 右サイドバーで Claude タブを開き、実 bash のプロンプトが出るまで待つ。 */
async function openClaude(page: Page): Promise<void> {
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('right-tab-claude').click();
  await expect(page.getByTestId('right-tab-claude')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('claude-panel')).toBeVisible();
  await expect(page.getByTestId('terminal')).toBeVisible();
  // 実 bash のプロンプト到着 = 接続確立 (xterm は DOM レンダラーなので文字が読める)
  await expect(page.getByTestId('terminal')).toContainText('$', { timeout: 15_000 });
}

async function typeCommand(page: Page, command: string): Promise<void> {
  await page.getByTestId('terminal').click();
  await page.keyboard.type(command, { delay: 10 });
  await page.keyboard.press('Enter');
}

test('[AC-Sf1a90a-2-1] Claude を右で開いてもメインのノートが見えたまま実シェルと対話できる', async ({
  page,
}) => {
  await openClaude(page);

  // Claude 表示中もメインのエディタ(ノート)は見えている (メインを占有しない)
  await expect(page.getByTestId('editor')).toBeVisible();

  // 入力エコーではなく実シェルの評価結果を確認する (双方向 I/O)
  await typeCommand(page, 'echo ui-e2e-$((6*7))');
  await expect(page.getByTestId('terminal')).toContainText('ui-e2e-42', { timeout: 10_000 });

  // cwd はハーネスの一時 vault (pty が vault で起動している)
  const vault = readHarnessState().vault;
  await typeCommand(page, 'pwd');
  await expect(page.getByTestId('terminal')).toContainText(path.basename(vault), {
    timeout: 10_000,
  });
});

test('[AC-Sf1a90a-2-1] バックリンク⇄Claude をトグルしてもセッションが維持される', async ({
  page,
}) => {
  await openClaude(page);
  await typeCommand(page, 'echo keep-alive-$((10+13))');
  await expect(page.getByTestId('terminal')).toContainText('keep-alive-23', { timeout: 10_000 });

  // インフォへ切替 → Claude は隠れるが unmount されない (S11493d-2: right-tab-info)
  await page.getByTestId('right-tab-info').click();
  await expect(page.getByTestId('info-panel')).toBeVisible();
  await expect(page.getByTestId('terminal')).toBeHidden();

  // 戻ると同じセッション (以前の出力が残っており、続けて対話できる)
  await page.getByTestId('right-tab-claude').click();
  await expect(page.getByTestId('terminal')).toBeVisible();
  await expect(page.getByTestId('terminal')).toContainText('keep-alive-23');
  await typeCommand(page, 'echo still-here-$((2+3))');
  await expect(page.getByTestId('terminal')).toContainText('still-here-5', { timeout: 10_000 });
});

/** `echo lines=$(tput lines)` を打ち込み、pty が認識している行数を読む。 */
async function readPtyLines(page: Page, marker: string): Promise<number> {
  await typeCommand(page, `echo ${marker}=$(tput lines)`);
  const re = new RegExp(`${marker}=(\\d+)`);
  await expect(page.getByTestId('terminal')).toContainText(re, { timeout: 10_000 });
  const text = await page.getByTestId('terminal').innerText();
  const m = re.exec(text);
  expect(m, `pty lines (${marker}) を読み取れませんでした`).not.toBeNull();
  return Number(m?.[1]);
}

test('[AC-Sf1a90a-2-1] ペインのリサイズに追従する (高さを縮めると行数が縮小する)', async ({ page }) => {
  // 右サイドバーは固定幅のため、高さ変化で pty の行数 (rows) が追従することを検証する
  await page.setViewportSize({ width: 1280, height: 900 });
  await openClaude(page);

  const linesTall = await readPtyLines(page, 'tall');
  expect(linesTall).toBeGreaterThan(0);

  await page.setViewportSize({ width: 1280, height: 400 });
  const linesShort = await readPtyLines(page, 'short');

  expect(linesShort).toBeGreaterThan(0);
  expect(linesShort).toBeLessThan(linesTall);
});

test('[AC-Sf1a90a-2-3] シェル終了 (exit) で終了コードと再接続導線が出て、再接続で新セッションが開く', async ({
  page,
}) => {
  await openClaude(page);

  await typeCommand(page, 'exit');
  const bar = page.getByTestId('terminal-reconnect-bar');
  await expect(bar).toBeVisible({ timeout: 10_000 });
  // 終了コード (bash の exit → 0) と三重ガード維持の明示が出る
  await expect(bar).toContainText('終了コード 0');
  await expect(bar).toContainText('三重ガード');

  await page.getByTestId('terminal-reconnect').click();
  await expect(bar).toBeHidden({ timeout: 10_000 });
  await typeCommand(page, 'echo reborn-$((5*5))');
  await expect(page.getByTestId('terminal')).toContainText('reborn-25', { timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// 無効状態 — LOAMIUM_TERMINAL 未設定の実サーバー + 実 Vite (モック不使用)
// ---------------------------------------------------------------------------

test.describe('[AC-Sf1a90a-2-2] サーバー側で無効な場合の表示 (実サーバー)', () => {
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

  test('Claude タブに無効の理由と有効化手順 (LOAMIUM_TERMINAL=1) が表示される', async ({ page }) => {
    await page.goto(uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible();
    await page.getByTestId('right-tab-claude').click();

    const claude = page.getByTestId('claude-panel');
    await expect(claude).toBeVisible();
    await expect(claude).toHaveAttribute('data-terminal-status', 'disabled');
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
