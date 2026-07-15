# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: packages/ui/tests/e2e/settings-view.mock.spec.ts >> [AC-Sa10026-7-3] append-only モードでも書込 UI が無効化される
- Location: packages/ui/tests/e2e/settings-view.mock.spec.ts:535:1

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
Call log:
  - navigating to "http://localhost:37521/", waiting until "load"

```

# Test source

```ts
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
  515 | 
  516 |   await page.goto(readHarnessState().uiUrl);
  517 |   await expect(page.getByTestId('editor')).toBeVisible();
  518 | 
  519 |   await page.getByTestId('sidebar-settings').click();
  520 |   await expect(page.getByTestId('settings-view')).toBeVisible();
  521 | 
  522 |   // mode-banner が表示される
  523 |   await expect(page.getByTestId('mode-banner')).toBeVisible();
  524 |   await expect(page.getByTestId('mode-banner')).toContainText('read-only モード');
  525 | 
  526 |   // 全体タブの保存ボタンが disabled
  527 |   await expect(page.locator('[data-testid="settings-save"][data-group="general"]')).toBeDisabled();
  528 | 
  529 |   // 入力フィールドも disabled
  530 |   await expect(page.locator('[data-testid="settings-field"][data-name="defaultFolder"]')).toBeDisabled();
  531 | 
  532 |   expect(unexpected).toEqual([]);
  533 | });
  534 | 
  535 | test('[AC-Sa10026-7-3] append-only モードでも書込 UI が無効化される', async ({ page }) => {
  536 |   const unexpected = await installCatchAll(page);
  537 |   await page.route('**/api/notes', (route) => {
  538 |     const url = route.request().url();
  539 |     if (!url.includes('/api/notes/')) {
  540 |       void route.fulfill(json({ notes: NOTES }));
  541 |       return;
  542 |     }
  543 |     void route.fallback();
  544 |   });
  545 |   await page.route('**/api/journal**', (route) => {
  546 |     void route.fulfill(json(journalResponse()));
  547 |   });
  548 |   await page.route('**/api/smart-folders', (route) => {
  549 |     void route.fulfill(json({ folders: [] }));
  550 |   });
  551 |   await page.route('**/api/health', (route) => {
  552 |     void route.fulfill(json({ status: 'ok', mode: 'append-only', agent: { enabled: false, reason: 'not_configured' } }));
  553 |   });
  554 | 
> 555 |   await page.goto(readHarnessState().uiUrl);
      |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
  556 |   await expect(page.getByTestId('editor')).toBeVisible();
  557 | 
  558 |   await page.getByTestId('sidebar-settings').click();
  559 | 
  560 |   await expect(page.getByTestId('mode-banner')).toBeVisible();
  561 |   await expect(page.getByTestId('mode-banner')).toContainText('append-only モード');
  562 |   await expect(page.locator('[data-testid="settings-save"][data-group="general"]')).toBeDisabled();
  563 | });
  564 | 
  565 | // ============================================================
  566 | // [AC-Sa10026-7-2] 導線リンクが存在する
  567 | // ============================================================
  568 | 
  569 | /**
  570 |  * Sa100c6-1 で per-item 導線リンク (settings-link) はコンテンツグループ nav-item に昇格。
  571 |  * settings-link は撤去され、代わりにコンテンツグループの nav-item が存在する。
  572 |  */
  573 | test('[AC-Sa10026-7-2→Sa100c6-1-1] テンプレート / SF / コマンドがコンテンツグループ nav-item として settings-nav に存在する', async ({ page }) => {
  574 |   await boot(page);
  575 | 
  576 |   await page.getByTestId('sidebar-settings').click();
  577 | 
  578 |   // 3 つのコンテンツグループ nav-item が visible (settings-link ではない)
  579 |   await expect(page.locator('[data-testid="settings-nav-item"][data-group="templates"]')).toBeVisible();
  580 |   await expect(page.locator('[data-testid="settings-nav-item"][data-group="smart-folders"]')).toBeVisible();
  581 |   await expect(page.locator('[data-testid="settings-nav-item"][data-group="commands"]')).toBeVisible();
  582 | 
  583 |   // settings-link は存在しない (撤去済み Sa100c6-1)
  584 |   await expect(page.locator('[data-testid="settings-link"]')).toHaveCount(0);
  585 | });
  586 | 
  587 | // ============================================================
  588 | // Edge: エージェント設定未設定時もパネルが表示される
  589 | // ============================================================
  590 | 
  591 | test('[MOCK] agent.json 未設定時 (connection: null) でもエージェントパネルが表示される', async ({ page }) => {
  592 |   const unexpected = await installCatchAll(page);
  593 |   await page.route('**/api/notes', (route) => {
  594 |     const url = route.request().url();
  595 |     if (!url.includes('/api/notes/')) {
  596 |       void route.fulfill(json({ notes: NOTES }));
  597 |       return;
  598 |     }
  599 |     void route.fallback();
  600 |   });
  601 |   await page.route('**/api/journal**', (route) => {
  602 |     void route.fulfill(json(journalResponse()));
  603 |   });
  604 |   await page.route('**/api/smart-folders', (route) => {
  605 |     void route.fulfill(json({ folders: [] }));
  606 |   });
  607 |   await page.route('**/api/settings/agent/connection', (route) => {
  608 |     if (route.request().method() === 'GET') {
  609 |       void route.fulfill(json({ connection: null }));
  610 |     } else {
  611 |       void route.fulfill(json({ ok: true }));
  612 |     }
  613 |   });
  614 |   await page.route('**/api/settings/agent/permissions', (route) => {
  615 |     if (route.request().method() === 'GET') {
  616 |       void route.fulfill(json({ permissions: null }));
  617 |     } else {
  618 |       void route.fulfill(json({ ok: true }));
  619 |     }
  620 |   });
  621 | 
  622 |   await page.goto(readHarnessState().uiUrl);
  623 |   await expect(page.getByTestId('editor')).toBeVisible();
  624 | 
  625 |   await page.getByTestId('sidebar-settings').click();
  626 |   await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  627 | 
  628 |   // パネルは表示される (未設定でもクラッシュしない)
  629 |   await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();
  630 | 
  631 |   expect(unexpected).toEqual([]);
  632 | });
  633 | 
  634 | // ============================================================
  635 | // Edge: save エラー時にステータスが error になる
  636 | // ============================================================
  637 | 
  638 | test('[MOCK] 保存 API エラー時に settings-status が error になる', async ({ page }) => {
  639 |   const unexpected = await installCatchAll(page);
  640 |   await page.route('**/api/notes', (route) => {
  641 |     const url = route.request().url();
  642 |     if (!url.includes('/api/notes/')) {
  643 |       void route.fulfill(json({ notes: NOTES }));
  644 |       return;
  645 |     }
  646 |     void route.fallback();
  647 |   });
  648 |   await page.route('**/api/journal**', (route) => {
  649 |     void route.fulfill(json(journalResponse()));
  650 |   });
  651 |   await page.route('**/api/smart-folders', (route) => {
  652 |     void route.fulfill(json({ folders: [] }));
  653 |   });
  654 |   await page.route('**/api/settings/system', (route) => {
  655 |     if (route.request().method() === 'GET') {
```