# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: packages/ui/tests/e2e/settings-view.mock.spec.ts >> [AC-Sa10026-7-1] 接続テスト失敗時はエラーメッセージが表示される
- Location: packages/ui/tests/e2e/settings-view.mock.spec.ts:268:1

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
Call log:
  - navigating to "http://localhost:37521/", waiting until "load"

```

# Test source

```ts
  188 |   await page.route('**/api/settings/agent/connection', (route) => {
  189 |     if (route.request().method() === 'GET') {
  190 |       void route.fulfill(json({
  191 |         connection: {
  192 |           api: 'anthropic',
  193 |           baseUrl: 'https://api.anthropic.com',
  194 |           model: 'claude-sonnet-4-6',
  195 |           apiKeyRef: '$ANTHROPIC_API_KEY',
  196 |         },
  197 |       }));
  198 |     } else {
  199 |       void route.fulfill(json({ ok: true }));
  200 |     }
  201 |   });
  202 | 
  203 |   await page.goto(readHarnessState().uiUrl);
  204 |   await expect(page.getByTestId('editor')).toBeVisible();
  205 | 
  206 |   await page.getByTestId('sidebar-settings').click();
  207 |   await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  208 |   await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();
  209 | 
  210 |   // apiKeyEnv フィールドが $ANTHROPIC_API_KEY を表示 (平文キーではない)
  211 |   const apiKeyField = page.locator('[data-testid="settings-field"][data-name="apiKeyEnv"]');
  212 |   await expect(apiKeyField).toBeVisible();
  213 |   await expect(apiKeyField).toHaveValue('$ANTHROPIC_API_KEY');
  214 | 
  215 |   // baseUrl も表示
  216 |   await expect(page.locator('[data-testid="settings-field"][data-name="baseUrl"]')).toHaveValue('https://api.anthropic.com');
  217 | 
  218 |   // model も表示
  219 |   await expect(page.locator('[data-testid="settings-field"][data-name="model"]')).toHaveValue('claude-sonnet-4-6');
  220 | 
  221 |   expect(unexpected).toEqual([]);
  222 | });
  223 | 
  224 | // ============================================================
  225 | // [AC-Sa10026-7-1] 接続テスト成功
  226 | // ============================================================
  227 | 
  228 | test('[AC-Sa10026-7-1] 接続テストボタンで成功メッセージが表示される', async ({ page }) => {
  229 |   const unexpected = await installCatchAll(page);
  230 |   await page.route('**/api/notes', (route) => {
  231 |     const url = route.request().url();
  232 |     if (!url.includes('/api/notes/')) {
  233 |       void route.fulfill(json({ notes: NOTES }));
  234 |       return;
  235 |     }
  236 |     void route.fallback();
  237 |   });
  238 |   await page.route('**/api/journal**', (route) => {
  239 |     void route.fulfill(json(journalResponse()));
  240 |   });
  241 |   await page.route('**/api/smart-folders', (route) => {
  242 |     void route.fulfill(json({ folders: [] }));
  243 |   });
  244 |   await page.route('**/api/settings/agent/connection/test', (route) => {
  245 |     void route.fulfill(json({ ok: true, model: 'claude-sonnet-4-6', latencyMs: 210 }));
  246 |   });
  247 | 
  248 |   await page.goto(readHarnessState().uiUrl);
  249 |   await expect(page.getByTestId('editor')).toBeVisible();
  250 | 
  251 |   await page.getByTestId('sidebar-settings').click();
  252 |   await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  253 | 
  254 |   // 接続テストボタンをクリック
  255 |   await page.getByTestId('settings-conn-test').click();
  256 | 
  257 |   // 結果が ok 状態になる
  258 |   await expect(page.getByTestId('settings-conn-result')).toHaveAttribute('data-state', 'ok');
  259 |   await expect(page.getByTestId('settings-conn-result')).toContainText('接続成功');
  260 | 
  261 |   expect(unexpected).toEqual([]);
  262 | });
  263 | 
  264 | // ============================================================
  265 | // [AC-Sa10026-7-1] 接続テスト失敗
  266 | // ============================================================
  267 | 
  268 | test('[AC-Sa10026-7-1] 接続テスト失敗時はエラーメッセージが表示される', async ({ page }) => {
  269 |   const unexpected = await installCatchAll(page);
  270 |   await page.route('**/api/notes', (route) => {
  271 |     const url = route.request().url();
  272 |     if (!url.includes('/api/notes/')) {
  273 |       void route.fulfill(json({ notes: NOTES }));
  274 |       return;
  275 |     }
  276 |     void route.fallback();
  277 |   });
  278 |   await page.route('**/api/journal**', (route) => {
  279 |     void route.fulfill(json(journalResponse()));
  280 |   });
  281 |   await page.route('**/api/smart-folders', (route) => {
  282 |     void route.fulfill(json({ folders: [] }));
  283 |   });
  284 |   await page.route('**/api/settings/agent/connection/test', (route) => {
  285 |     void route.fulfill(json({ ok: false, error: '401 unauthorized' }));
  286 |   });
  287 | 
> 288 |   await page.goto(readHarnessState().uiUrl);
      |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
  289 |   await expect(page.getByTestId('editor')).toBeVisible();
  290 | 
  291 |   await page.getByTestId('sidebar-settings').click();
  292 |   await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  293 | 
  294 |   await page.getByTestId('settings-conn-test').click();
  295 | 
  296 |   // エラー状態になる
  297 |   await expect(page.getByTestId('settings-conn-result')).toHaveAttribute('data-state', 'error');
  298 |   await expect(page.getByTestId('settings-conn-result')).toContainText('401 unauthorized');
  299 | 
  300 |   expect(unexpected).toEqual([]);
  301 | });
  302 | 
  303 | // ============================================================
  304 | // [AC-Sa10026-7-1] モデル一覧取得 + 直接入力
  305 | // ============================================================
  306 | 
  307 | test('[AC-Sa10026-7-1] 一覧取得でモデル候補が settings-model-options に反映される', async ({ page }) => {
  308 |   const unexpected = await installCatchAll(page);
  309 |   await page.route('**/api/notes', (route) => {
  310 |     const url = route.request().url();
  311 |     if (!url.includes('/api/notes/')) {
  312 |       void route.fulfill(json({ notes: NOTES }));
  313 |       return;
  314 |     }
  315 |     void route.fallback();
  316 |   });
  317 |   await page.route('**/api/journal**', (route) => {
  318 |     void route.fulfill(json(journalResponse()));
  319 |   });
  320 |   await page.route('**/api/smart-folders', (route) => {
  321 |     void route.fulfill(json({ folders: [] }));
  322 |   });
  323 |   await page.route('**/api/settings/agent/models', (route) => {
  324 |     void route.fulfill(json({ models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'], source: 'api' }));
  325 |   });
  326 | 
  327 |   await page.goto(readHarnessState().uiUrl);
  328 |   await expect(page.getByTestId('editor')).toBeVisible();
  329 | 
  330 |   await page.getByTestId('sidebar-settings').click();
  331 |   await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  332 | 
  333 |   // 一覧取得ボタンをクリック
  334 |   await page.getByTestId('settings-model-refresh').click();
  335 | 
  336 |   // コンボボックスが開いて候補が表示される
  337 |   await expect(page.getByTestId('settings-model-combobox')).toHaveClass(/open/);
  338 |   const options = page.getByTestId('settings-model-options');
  339 |   await expect(options).toBeVisible();
  340 |   await expect(options.locator('li')).toHaveCount(3);
  341 | 
  342 |   expect(unexpected).toEqual([]);
  343 | });
  344 | 
  345 | test('[AC-Sa10026-7-1] モデルコンボボックスで直接入力できる', async ({ page }) => {
  346 |   await boot(page);
  347 | 
  348 |   await page.getByTestId('sidebar-settings').click();
  349 |   await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  350 | 
  351 |   // モデル入力欄に直接入力
  352 |   const modelField = page.locator('[data-testid="settings-field"][data-name="model"]');
  353 |   await modelField.fill('custom-model-id-not-in-list');
  354 |   await expect(modelField).toHaveValue('custom-model-id-not-in-list');
  355 | });
  356 | 
  357 | test('[AC-Sa10026-7-1] settings-model-toggle でコンボボックスが開閉する', async ({ page }) => {
  358 |   await boot(page);
  359 | 
  360 |   await page.getByTestId('sidebar-settings').click();
  361 |   await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  362 | 
  363 |   const combobox = page.getByTestId('settings-model-combobox');
  364 |   const toggle = page.getByTestId('settings-model-toggle');
  365 | 
  366 |   // 初期状態は閉じている
  367 |   await expect(combobox).not.toHaveClass(/open/);
  368 | 
  369 |   // トグルクリックで開く
  370 |   await toggle.click();
  371 |   await expect(combobox).toHaveClass(/open/);
  372 | 
  373 |   // 再クリックで閉じる
  374 |   await toggle.click();
  375 |   await expect(combobox).not.toHaveClass(/open/);
  376 | });
  377 | 
  378 | // ============================================================
  379 | // [AC-Sa10026-7-1] プライバシー deny-list 追加・削除
  380 | // ============================================================
  381 | 
  382 | test('[AC-Sa10026-7-1] deny-list エントリを追加できる', async ({ page }) => {
  383 |   const putCalls: Array<{ deny: string[] }> = [];
  384 | 
  385 |   const unexpected = await installCatchAll(page);
  386 |   await page.route('**/api/notes', (route) => {
  387 |     const url = route.request().url();
  388 |     if (!url.includes('/api/notes/')) {
```