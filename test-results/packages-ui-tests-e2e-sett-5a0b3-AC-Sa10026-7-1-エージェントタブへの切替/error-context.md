# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: packages/ui/tests/e2e/settings-view.mock.spec.ts >> [AC-Sa10026-7-1] エージェントタブへの切替
- Location: packages/ui/tests/e2e/settings-view.mock.spec.ts:81:1

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
Call log:
  - navigating to "http://localhost:37521/", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * 統一設定画面 mock テスト (Sa10026-7)。
  3   |  *
  4   |  * page.route で API をモックし、ブラウザ上で UI の動作を検証する。
  5   |  * サーバーは起動しない。
  6   |  *
  7   |  * [AC-Sa10026-7-1] 統一設定画面が左ナビを持ち、各群を型付き API 経由で編集・保存できる。
  8   |  * [AC-Sa10026-7-2] テンプレ/SF/コマンドは導線リンク (per-item 管理はここに再実装しない)。
  9   |  * [AC-Sa10026-7-3] apiKey は $ENV_VAR 参照として表示。read-only/append-only では書込 UI 無効化。
  10  |  */
  11  | import { test, expect, type Page } from '@playwright/test';
  12  | import { readHarnessState } from '../harness/state.js';
  13  | import { installCatchAll, json } from '../harness/mock-helpers.js';
  14  | 
  15  | const DATE = '2026-07-14';
  16  | const JOURNAL_PATH = `journals/${DATE}.md`;
  17  | 
  18  | function journalResponse(): Record<string, unknown> {
  19  |   return {
  20  |     date: DATE,
  21  |     path: JOURNAL_PATH,
  22  |     content: '',
  23  |     frontmatter: null,
  24  |     body: '',
  25  |     created: false,
  26  |     mtime: 1000,
  27  |   };
  28  | }
  29  | 
  30  | const NOTES = [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals', mtime: 1000 }];
  31  | 
  32  | /** 共通ブートストラップ: app を起動してジャーナルが開いた状態にする */
  33  | async function boot(page: Page): Promise<string[]> {
  34  |   const unexpected = await installCatchAll(page);
  35  | 
  36  |   await page.route('**/api/notes', (route) => {
  37  |     const url = route.request().url();
  38  |     if (!url.includes('/api/notes/')) {
  39  |       void route.fulfill(json({ notes: NOTES }));
  40  |       return;
  41  |     }
  42  |     void route.fallback();
  43  |   });
  44  |   await page.route('**/api/journal**', (route) => {
  45  |     void route.fulfill(json(journalResponse()));
  46  |   });
  47  |   await page.route('**/api/smart-folders', (route) => {
  48  |     void route.fulfill(json({ folders: [] }));
  49  |   });
  50  | 
> 51  |   await page.goto(readHarnessState().uiUrl);
      |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
  52  |   await expect(page.getByTestId('editor')).toBeVisible();
  53  | 
  54  |   return unexpected;
  55  | }
  56  | 
  57  | // ============================================================
  58  | // [AC-Sa10026-7-1] 設定画面の開閉とナビ
  59  | // ============================================================
  60  | 
  61  | test('[AC-Sa10026-7-1] sidebar-settings クリックで設定画面が開く', async ({ page }) => {
  62  |   await boot(page);
  63  | 
  64  |   // 設定ボタンをクリック
  65  |   await page.getByTestId('sidebar-settings').click();
  66  | 
  67  |   // settings-view が表示される
  68  |   await expect(page.getByTestId('settings-view')).toBeVisible();
  69  | 
  70  |   // 左ナビに 3 群が存在する
  71  |   await expect(page.locator('[data-testid="settings-nav-item"][data-group="general"]')).toBeVisible();
  72  |   await expect(page.locator('[data-testid="settings-nav-item"][data-group="agent"]')).toBeVisible();
  73  |   await expect(page.locator('[data-testid="settings-nav-item"][data-group="privacy"]')).toBeVisible();
  74  | 
  75  |   // 全体タブが初期アクティブ
  76  |   await expect(page.locator('[data-testid="settings-panel"][data-group="general"]')).toBeVisible();
  77  |   await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).not.toBeVisible();
  78  |   await expect(page.locator('[data-testid="settings-panel"][data-group="privacy"]')).not.toBeVisible();
  79  | });
  80  | 
  81  | test('[AC-Sa10026-7-1] エージェントタブへの切替', async ({ page }) => {
  82  |   await boot(page);
  83  | 
  84  |   await page.getByTestId('sidebar-settings').click();
  85  |   await expect(page.getByTestId('settings-view')).toBeVisible();
  86  | 
  87  |   // エージェントタブをクリック
  88  |   await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  89  | 
  90  |   // エージェントパネルが表示される
  91  |   await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();
  92  |   await expect(page.locator('[data-testid="settings-panel"][data-group="general"]')).not.toBeVisible();
  93  | });
  94  | 
  95  | test('[AC-Sa10026-7-1] プライバシータブへの切替', async ({ page }) => {
  96  |   await boot(page);
  97  | 
  98  |   await page.getByTestId('sidebar-settings').click();
  99  | 
  100 |   await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();
  101 |   await expect(page.locator('[data-testid="settings-panel"][data-group="privacy"]')).toBeVisible();
  102 | });
  103 | 
  104 | // ============================================================
  105 | // [AC-Sa10026-7-1] 全体設定の保存
  106 | // ============================================================
  107 | 
  108 | test('[AC-Sa10026-7-1] 全体設定を変更して保存すると PUT /api/settings/system が呼ばれる', async ({ page }) => {
  109 |   const putCalls: Array<Record<string, unknown>> = [];
  110 | 
  111 |   // PUT を記録するルートを上書き
  112 |   const unexpected = await installCatchAll(page);
  113 |   await page.route('**/api/notes', (route) => {
  114 |     const url = route.request().url();
  115 |     if (!url.includes('/api/notes/')) {
  116 |       void route.fulfill(json({ notes: NOTES }));
  117 |       return;
  118 |     }
  119 |     void route.fallback();
  120 |   });
  121 |   await page.route('**/api/journal**', (route) => {
  122 |     void route.fulfill(json(journalResponse()));
  123 |   });
  124 |   await page.route('**/api/smart-folders', (route) => {
  125 |     void route.fulfill(json({ folders: [] }));
  126 |   });
  127 |   await page.route('**/api/settings/system', (route) => {
  128 |     const method = route.request().method();
  129 |     if (method === 'GET') {
  130 |       void route.fulfill(json({ settings: { theme: 'system', defaultFolder: '', journalTemplate: 'system/templates/journal.md', showSystemFolder: false } }));
  131 |     } else if (method === 'PUT') {
  132 |       const body = route.request().postDataJSON() as Record<string, unknown>;
  133 |       putCalls.push(body);
  134 |       void route.fulfill(json({ settings: (body as { settings: Record<string, unknown> }).settings }));
  135 |     } else {
  136 |       void route.fallback();
  137 |     }
  138 |   });
  139 | 
  140 |   await page.goto(readHarnessState().uiUrl);
  141 |   await expect(page.getByTestId('editor')).toBeVisible();
  142 | 
  143 |   await page.getByTestId('sidebar-settings').click();
  144 |   await expect(page.getByTestId('settings-view')).toBeVisible();
  145 | 
  146 |   // defaultFolder を 'notes' に変更
  147 |   await page.locator('[data-testid="settings-field"][data-name="defaultFolder"]').fill('notes');
  148 | 
  149 |   // 保存ボタンをクリック
  150 |   await page.locator('[data-testid="settings-save"][data-group="general"]').click();
  151 | 
```