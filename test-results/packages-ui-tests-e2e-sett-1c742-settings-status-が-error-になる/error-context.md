# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: packages/ui/tests/e2e/settings-view.mock.spec.ts >> [MOCK] 保存 API エラー時に settings-status が error になる
- Location: packages/ui/tests/e2e/settings-view.mock.spec.ts:638:1

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
Call log:
  - navigating to "http://localhost:37521/", waiting until "load"

```

# Test source

```ts
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
  656 |       void route.fulfill(json({ settings: { theme: 'system', defaultFolder: '', journalTemplate: 'system/templates/journal.md', showSystemFolder: false } }));
  657 |     } else if (route.request().method() === 'PUT') {
  658 |       void route.fulfill(json({ error: 'settings_write_error', message: 'disk full' }, 500));
  659 |     } else {
  660 |       void route.fallback();
  661 |     }
  662 |   });
  663 | 
> 664 |   await page.goto(readHarnessState().uiUrl);
      |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:37521/
  665 |   await expect(page.getByTestId('editor')).toBeVisible();
  666 | 
  667 |   await page.getByTestId('sidebar-settings').click();
  668 |   await page.locator('[data-testid="settings-save"][data-group="general"]').click();
  669 | 
  670 |   await expect(page.getByTestId('settings-status')).toHaveAttribute('data-state', 'error');
  671 | 
  672 |   expect(unexpected).toEqual([]);
  673 | });
  674 | 
```