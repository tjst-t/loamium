/**
 * Story S1bd397-4「入力フォーム UI — 動的選択肢」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * テスト vault に #project ノードと epic-optionsquery テンプレートをシードし、
 * TemplateModal で select+optionsQuery の候補がドロップダウンに出ることを検証。
 * コマンドの create-epic (select+optionsQuery) のパレット→フォームフローも検証。
 *
 * 【前提】
 *   globalSetup または beforeAll が以下をシードする:
 *   - projects/loamium.md (tags: [project])
 *   - projects/webapp.md  (tags: [project])
 *   - system/templates/epic-optionsquery.md (select+optionsQuery: LIST FROM #project)
 *   - system/commands/create-epic.yaml (select param + optionsQuery)
 *
 * [AC-S1bd397-4-1] TemplateModal: select+optionsQuery → 動的候補ドロップダウン
 * [AC-S1bd397-4-2] コマンド実行フォーム: select+optionsQuery → 動的候補ドロップダウン
 * [AC-S1bd397-4-4] モバイルレスポンシブ (viewport 390px)
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

// ---- シードデータ ----

const EPIC_TEMPLATE = [
  '---',
  'loamium-template:',
  '  description: Epic テンプレート (optionsQuery E2E)',
  '  target: "projects/{{プロジェクト名}}/epics/{{Epic名}}"',
  '  vars:',
  '    - name: プロジェクト名',
  '      type: select',
  '      required: true',
  '      label: プロジェクト',
  '      optionsQuery: "LIST FROM #project"',
  '    - name: Epic名',
  '      type: text',
  '      required: true',
  '      label: Epic 名',
  '---',
  '# {{Epic名}}',
  '',
  'プロジェクト: {{プロジェクト名}}',
].join('\n');

const CREATE_EPIC_COMMAND = [
  'name: create-epic',
  'description: Epic ノート作成 (optionsQuery E2E)',
  'params:',
  '  - name: プロジェクト',
  '    type: select',
  '    required: true',
  '    label: プロジェクト',
  '    optionsQuery: "LIST FROM #project"',
  '  - name: title',
  '    type: text',
  '    required: true',
  '    label: Epic タイトル',
  'steps:',
  '  - kind: note-create',
  '    target: "projects/{{プロジェクト}}/epics/{{title}}"',
  '    content: "# {{title}}"',
].join('\n');

test.beforeAll(async () => {
  const { vault } = state();
  // プロジェクトノードを 2 件シード
  await mkdir(path.join(vault, 'projects'), { recursive: true });
  await writeFile(
    path.join(vault, 'projects', 'loamium.md'),
    '---\ntags: [project]\n---\n# loamium\n',
    'utf8',
  );
  await writeFile(
    path.join(vault, 'projects', 'webapp.md'),
    '---\ntags: [project]\n---\n# webapp\n',
    'utf8',
  );

  // テンプレートシード
  await mkdir(path.join(vault, 'system', 'templates'), { recursive: true });
  await writeFile(
    path.join(vault, 'system', 'templates', 'epic-optionsquery.md'),
    EPIC_TEMPLATE,
    'utf8',
  );

  // コマンドシード
  await mkdir(path.join(vault, 'system', 'commands'), { recursive: true });
  await writeFile(
    path.join(vault, 'system', 'commands', 'create-epic.yaml'),
    CREATE_EPIC_COMMAND,
    'utf8',
  );
});

test.beforeEach(async ({ page }) => {
  await page.goto(state().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 15_000 });
});

async function openEpicTemplateModal(page: Page): Promise<void> {
  await page.getByTestId('sidebar-new-note').click();
  await expect(page.getByTestId('new-note-menu')).toBeVisible();
  await page.getByTestId('new-note-menu-template').click();
  await expect(page.getByTestId('template-picker')).toBeVisible();
  await page.locator('[data-testid="template-item"][data-template="epic-optionsquery"]').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
}

// ---- AC-S1bd397-4-1: TemplateModal select+optionsQuery ----

test('[AC-S1bd397-4-1][E2E] TemplateModal: select+optionsQuery → #project 候補がドロップダウンに表示される', async ({
  page,
}) => {
  await openEpicTemplateModal(page);
  const modal = page.getByTestId('template-modal');

  // loading→loaded の transient loading 表示は、実サーバーだと候補取得が即解決してレースになる
  // (playwright が観測する前に消える)。loading インジケータの検証は応答時間を制御できる
  // 決定的な dynamic-options.mock.spec.ts で担保し、この E2E は実サーバーの候補が実際に
  // ドロップダウンへ反映されること(loaded 状態)を検証する。
  const selectInput = modal.locator(
    '[data-testid="template-var-input"][data-var="プロジェクト名"][data-widget="dynamic-select"]',
  );
  await expect(selectInput).toBeVisible({ timeout: 10_000 });

  // ドロップダウンに loamium と webapp が含まれる
  await expect(selectInput.locator('option', { hasText: 'loamium' })).toBeAttached();
  await expect(selectInput.locator('option', { hasText: 'webapp' })).toBeAttached();
});

test('[AC-S1bd397-4-1][E2E] TemplateModal: select+optionsQuery で選択→instantiate → ピュア Markdown 生成', async ({
  page,
}) => {
  await openEpicTemplateModal(page);
  const modal = page.getByTestId('template-modal');

  // プロジェクト名の選択候補が表示されるまで待つ
  const selectInput = modal.locator(
    '[data-testid="template-var-input"][data-var="プロジェクト名"][data-widget="dynamic-select"]',
  );
  await expect(selectInput).toBeVisible({ timeout: 10_000 });

  // loamium を選択
  await selectInput.selectOption('loamium');

  // Epic名を入力
  await modal.locator('[data-testid="template-var-input"][data-var="Epic名"]').fill('DQL機能');

  // 作成
  await modal.getByTestId('template-create').click();
  await expect(page.getByTestId('template-modal')).toHaveCount(0);

  // 生成ノートがエディタで開く
  await expect(page.getByTestId('editor')).toContainText('DQL機能');

  // 実ファイルを検証 (ピュア Markdown)
  const { vault } = state();
  const raw = await readFile(
    path.join(vault, 'projects', 'loamium', 'epics', 'DQL機能.md'),
    'utf8',
  );
  expect(raw).not.toContain('{{');
  expect(raw).toContain('# DQL機能');
  expect(raw).toContain('loamium');
});

// ---- AC-S1bd397-4-2: コマンド実行フォーム select+optionsQuery ----

test('[AC-S1bd397-4-2][E2E] コマンド param フォーム: select+optionsQuery → 候補ドロップダウン', async ({
  page,
}) => {
  // Ctrl-K でパレットを開く
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // '> epic' で絞り込み
  await page.getByTestId('search-input').fill('> epic');
  const epicItem = page.locator(
    '[data-testid="command-item"][data-command-id="smart:create-epic"]',
  );
  await expect(epicItem).toBeVisible({ timeout: 5_000 });
  await epicItem.click();

  // param フォームが開く
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // プロジェクトの select フィールドが動的候補で初期化
  const selectField = page.locator(
    '[data-testid="param-field-input"][data-name="プロジェクト"][data-widget="dynamic-select"]',
  );
  await expect(selectField).toBeVisible({ timeout: 10_000 });
  await expect(selectField.locator('option', { hasText: 'loamium' })).toBeAttached();
  await expect(selectField.locator('option', { hasText: 'webapp' })).toBeAttached();
});

// ---- AC-S1bd397-4-4: モバイルレスポンシブ ----

test('[AC-S1bd397-4-4][E2E] モバイル viewport (390px) で TemplateModal が表示される', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEpicTemplateModal(page);
  const modal = page.getByTestId('template-modal');
  await expect(modal).toBeVisible();

  // タップターゲット (作成ボタン) が 44px 以上
  const createBtn = modal.getByTestId('template-create');
  const box = await createBtn.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
