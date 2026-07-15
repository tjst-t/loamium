# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: packages/ui/tests/e2e/settings-view.mock.spec.ts >> [AC-Sa10026-7-1] deny-list エントリを追加できる
- Location: packages/ui/tests/e2e/settings-view.mock.spec.ts:382:1

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
Call log:
  - navigating to "http://localhost:37521/", waiting until "load"

```

# Test source

```ts
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
  389 |       void route.fulfill(json({ notes: NOTES }));
  390 |       return;
  391 |     }
  392 |     void route.fallback();
  393 |   });
  394 |   await page.route('**/api/journal**', (route) => {
  395 |     void route.fulfill(json(journalResponse()));
  396 |   });
  397 |   await page.route('**/api/smart-folders', (route) => {
  398 |     void route.fulfill(json({ folders: [] }));
  399 |   });
  400 |   await page.route('**/api/settings/agent/privacy', (route) => {
  401 |     const method = route.request().method();
  402 |     if (method === 'GET') {
  403 |       void route.fulfill(json({ deny: ['private/**'] }));
  404 |     } else if (method === 'PUT') {
  405 |       const body = route.request().postDataJSON() as { deny: string[] };
  406 |       putCalls.push(body);
  407 |       // 実サーバーに合わせ、保存後の deny-list をそのまま返す ({ deny })。
  408 |       void route.fulfill(json({ deny: body.deny }));
  409 |     } else {
  410 |       void route.fallback();
  411 |     }
  412 |   });
  413 | 
> 414 |   await page.goto(readHarnessState().uiUrl);
      |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
  415 |   await expect(page.getByTestId('editor')).toBeVisible();
  416 | 
  417 |   await page.getByTestId('sidebar-settings').click();
  418 |   await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();
  419 | 
  420 |   // 既存エントリが表示される
  421 |   await expect(page.locator('[data-testid="deny-entry"][data-value="private/**"]')).toBeVisible();
  422 | 
  423 |   // 新しいエントリを追加
  424 |   await page.getByTestId('deny-add-input').fill('secrets/**');
  425 |   await page.getByTestId('deny-add').click();
  426 | 
  427 |   // UI に追加される
  428 |   await expect(page.locator('[data-testid="deny-entry"][data-value="secrets/**"]')).toBeVisible();
  429 | 
  430 |   // 保存
  431 |   await page.locator('[data-testid="settings-save"][data-group="privacy"]').click();
  432 | 
  433 |   // PUT が呼ばれた
  434 |   await expect(async () => {
  435 |     expect(putCalls.length).toBeGreaterThan(0);
  436 |   }).toPass({ timeout: 3000 });
  437 |   const firstCall = putCalls[0];
  438 |   expect(firstCall).toBeDefined();
  439 |   expect(firstCall?.deny).toContain('secrets/**');
  440 |   expect(firstCall?.deny).toContain('private/**');
  441 | 
  442 |   expect(unexpected).toEqual([]);
  443 | });
  444 | 
  445 | test('[AC-Sa10026-7-1] deny-list エントリを削除できる', async ({ page }) => {
  446 |   const unexpected = await installCatchAll(page);
  447 |   await page.route('**/api/notes', (route) => {
  448 |     const url = route.request().url();
  449 |     if (!url.includes('/api/notes/')) {
  450 |       void route.fulfill(json({ notes: NOTES }));
  451 |       return;
  452 |     }
  453 |     void route.fallback();
  454 |   });
  455 |   await page.route('**/api/journal**', (route) => {
  456 |     void route.fulfill(json(journalResponse()));
  457 |   });
  458 |   await page.route('**/api/smart-folders', (route) => {
  459 |     void route.fulfill(json({ folders: [] }));
  460 |   });
  461 |   await page.route('**/api/settings/agent/privacy', (route) => {
  462 |     if (route.request().method() === 'GET') {
  463 |       void route.fulfill(json({ deny: ['private/**', 'secrets/**'] }));
  464 |     } else {
  465 |       // 実サーバーに合わせ、保存後の deny-list をそのまま返す ({ deny })。
  466 |       const body = route.request().postDataJSON() as { deny: string[] };
  467 |       void route.fulfill(json({ deny: body.deny }));
  468 |     }
  469 |   });
  470 | 
  471 |   await page.goto(readHarnessState().uiUrl);
  472 |   await expect(page.getByTestId('editor')).toBeVisible();
  473 | 
  474 |   await page.getByTestId('sidebar-settings').click();
  475 |   await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();
  476 | 
  477 |   // 2 件表示
  478 |   await expect(page.locator('[data-testid="deny-entry"]')).toHaveCount(2);
  479 | 
  480 |   // 1 件削除
  481 |   await page.locator('[data-testid="deny-entry"][data-value="secrets/**"] [data-testid="deny-del"]').click();
  482 | 
  483 |   // 1 件になる
  484 |   await expect(page.locator('[data-testid="deny-entry"]')).toHaveCount(1);
  485 |   await expect(page.locator('[data-testid="deny-entry"][data-value="private/**"]')).toBeVisible();
  486 |   await expect(page.locator('[data-testid="deny-entry"][data-value="secrets/**"]')).not.toBeVisible();
  487 | 
  488 |   expect(unexpected).toEqual([]);
  489 | });
  490 | 
  491 | // ============================================================
  492 | // [AC-Sa10026-7-3] read-only モードで書込 UI が無効化される
  493 | // ============================================================
  494 | 
  495 | test('[AC-Sa10026-7-3] LOAMIUM_MODE=read-only では保存ボタンが disabled になる', async ({ page }) => {
  496 |   const unexpected = await installCatchAll(page);
  497 |   await page.route('**/api/notes', (route) => {
  498 |     const url = route.request().url();
  499 |     if (!url.includes('/api/notes/')) {
  500 |       void route.fulfill(json({ notes: NOTES }));
  501 |       return;
  502 |     }
  503 |     void route.fallback();
  504 |   });
  505 |   await page.route('**/api/journal**', (route) => {
  506 |     void route.fulfill(json(journalResponse()));
  507 |   });
  508 |   await page.route('**/api/smart-folders', (route) => {
  509 |     void route.fulfill(json({ folders: [] }));
  510 |   });
  511 |   // read-only モードを返す health
  512 |   await page.route('**/api/health', (route) => {
  513 |     void route.fulfill(json({ status: 'ok', mode: 'read-only', agent: { enabled: false, reason: 'not_configured' } }));
  514 |   });
```