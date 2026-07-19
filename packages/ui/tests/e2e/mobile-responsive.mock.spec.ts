/**
 * Sa6c3b0 モバイルレスポンシブ — mock テスト (Stories 1/2/3/6)
 *
 * viewport 幅 ≤680px のモバイル挙動を検証する:
 * - サイドバーオーバーレイ開閉 (sidebar-toggle / sidebar-scrim)
 * - ノート/スマート セグメントトグル (sidebar-view-toggle / -physical / -smart)
 * - タッチターゲットサイズ (icon-btn / tree-item / sidebar-bottom-btn)
 * - ボトムバー + Agent シート開閉 (mobile-bottom-nav / mobile-agent-sheet / -close)
 * - manifest <link> の存在 (AC-4-1)
 * - SW 登録ガード (DEV ではスキップ — AC-4-2 注)
 *
 * 実サーバー不要: 全 /api/* を page.route でモック。
 */
import { test, expect, type Page } from '@playwright/test';
import { installCatchAll, json } from '../harness/mock-helpers.js';
import { readHarnessState } from '../harness/state.js';

const MOBILE_VIEWPORT = { width: 375, height: 667 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

const JOURNAL_PATH = 'journals/2026-07-11.md';

async function openMobileApp(page: Page): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: JOURNAL_PATH, title: '2026-07-11', tags: [], folder: 'journals' },
          { path: 'projects/計画.md', title: '計画', tags: [], folder: 'projects' },
        ],
      }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(
      json({
        date: '2026-07-11',
        path: JOURNAL_PATH,
        content: '# テストジャーナル\n\n本文。\n',
        frontmatter: null,
        body: '# テストジャーナル\n\n本文。\n',
        created: false,
        mtime: 1000,
      }),
    );
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
}

// ---- manifest / PWA ----

test('[MOCK][mobile] index.html に manifest <link> と theme-color が存在する (AC-4-1)', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await installCatchAll(page);
  await page.route('**/api/journal', (route) => {
    void route.fulfill(
      json({ date: '2026-07-11', path: JOURNAL_PATH, content: '', frontmatter: null, body: '', created: false, mtime: 1000 }),
    );
  });
  await page.goto(readHarnessState().uiUrl);
  // manifest link
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', '/manifest.json');
  // theme-color meta
  const themeColor = page.locator('meta[name="theme-color"]');
  await expect(themeColor).toHaveAttribute('content', '#6e56cf');
});

// ---- サイドバーオーバーレイ ----

test('[MOCK][mobile] ≤680px でサイドバーはデフォルト非表示、ハンバーガーで表示', async ({ page }) => {
  await openMobileApp(page);

  // デフォルトでサイドバーは hidden (data-mobile-open="false")
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toHaveAttribute('data-mobile-open', 'false');

  // ハンバーガーをタップ
  await page.getByTestId('sidebar-toggle').click();
  await expect(sidebar).toHaveAttribute('data-mobile-open', 'true');

  // スクリムが表示される
  await expect(page.getByTestId('sidebar-scrim')).toBeVisible();
});

test('[MOCK][mobile] スクリムタップでサイドバーが閉じる (AC-1-3)', async ({ page }) => {
  await openMobileApp(page);

  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-mobile-open', 'true');

  await page.getByTestId('sidebar-scrim').click();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-mobile-open', 'false');
  // スクリムも消える
  await expect(page.getByTestId('sidebar-scrim')).not.toBeVisible();
});

test('[MOCK][mobile] ノート選択でサイドバーが自動クローズ (AC-1-6)', async ({ page }) => {
  await openMobileApp(page);

  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-mobile-open', 'true');

  // ツリーからノートを選択
  await page.getByTestId('tree-item').first().click();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-mobile-open', 'false');
});

// ---- ノート/スマート セグメントトグル ----

test('[MOCK][mobile] sidebar-view-toggle が sidebar 内に存在する (AC-1-7)', async ({ page }) => {
  await openMobileApp(page);
  await page.getByTestId('sidebar-toggle').click();

  // モバイル用トグルは role="tablist" で識別 (既存の aria-pressed バリアントと区別)
  const toggle = page.locator('[data-testid="sidebar-view-toggle"][role="tablist"]');
  await expect(toggle).toBeVisible();

  // tablist 内の physical / smart ボタン (aria-selected を持つ)
  const physBtn = toggle.locator('[data-testid="sidebar-view-physical"]');
  const smartBtn = toggle.locator('[data-testid="sidebar-view-smart"]');
  await expect(physBtn).toBeVisible();
  await expect(smartBtn).toBeVisible();

  // デフォルトは physical
  await expect(physBtn).toHaveAttribute('aria-selected', 'true');
  await expect(smartBtn).toHaveAttribute('aria-selected', 'false');
});

test('[MOCK][mobile] スマートタブに切り替えると aria-selected が変わる (AC-1-7)', async ({ page }) => {
  await openMobileApp(page);
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ folders: [], mode: 'full' }));
  });
  await page.getByTestId('sidebar-toggle').click();

  const toggle = page.locator('[data-testid="sidebar-view-toggle"][role="tablist"]');
  await toggle.locator('[data-testid="sidebar-view-smart"]').click();
  await expect(toggle.locator('[data-testid="sidebar-view-smart"]')).toHaveAttribute('aria-selected', 'true');
  await expect(toggle.locator('[data-testid="sidebar-view-physical"]')).toHaveAttribute('aria-selected', 'false');
});

// ---- タッチターゲット ----

test('[MOCK][mobile] icon-btn の computed height が ≥44px (AC-2-1)', async ({ page }) => {
  await openMobileApp(page);
  await page.getByTestId('sidebar-toggle').click();

  // sidebar-toggle 自体のサイズ
  const toggleBtn = page.getByTestId('sidebar-toggle');
  const box = await toggleBtn.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
});

test('[MOCK][mobile] tree-item の computed height が ≥44px (AC-2-2)', async ({ page }) => {
  await openMobileApp(page);
  await page.getByTestId('sidebar-toggle').click();

  const treeItems = page.getByTestId('tree-item');
  const count = await treeItems.count();
  if (count > 0) {
    const box = await treeItems.first().boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
});

// ---- デスクトップ: ボトムバー・ハンバーガー非表示 ----

test('[MOCK][desktop] ≥961px でボトムバー・ハンバーガーは非表示 (AC-6-4)', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(
      json({ date: '2026-07-11', path: JOURNAL_PATH, content: '', frontmatter: null, body: '', created: false, mtime: 1000 }),
    );
  });
  await page.goto(readHarnessState().uiUrl);

  // sidebar-toggle はデスクトップでは非表示
  await expect(page.getByTestId('sidebar-toggle')).not.toBeVisible();
  // ボトムナビも非表示
  await expect(page.getByTestId('mobile-bottom-nav')).not.toBeVisible();
});

// ---- ボトムバー & Agent シート ----

test('[MOCK][mobile] ボトムバーの 3 アイテムが表示される (AC-6-1)', async ({ page }) => {
  await openMobileApp(page);

  await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible();
  await expect(page.getByTestId('mobile-nav-notes')).toBeVisible();
  await expect(page.getByTestId('mobile-nav-search')).toBeVisible();
  await expect(page.getByTestId('mobile-nav-agent')).toBeVisible();

  // 各アイテムの高さ ≥44px
  for (const testid of ['mobile-nav-notes', 'mobile-nav-search', 'mobile-nav-agent']) {
    const box = await page.getByTestId(testid).boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test('[MOCK][mobile] Agent タップで mobile-agent-sheet が開く (AC-6-2)', async ({ page }) => {
  await openMobileApp(page);
  await page.route('**/api/health', (route) => {
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }),
    );
  });

  await page.getByTestId('mobile-nav-agent').click();

  const sheet = page.getByTestId('mobile-agent-sheet');
  await expect(sheet).toHaveAttribute('data-open', 'true');
});

test('[MOCK][mobile] mobile-agent-sheet-close でシートが閉じる (AC-6-3)', async ({ page }) => {
  await openMobileApp(page);
  await page.route('**/api/health', (route) => {
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }),
    );
  });

  await page.getByTestId('mobile-nav-agent').click();
  await expect(page.getByTestId('mobile-agent-sheet')).toHaveAttribute('data-open', 'true');

  await page.getByTestId('mobile-agent-sheet-close').click();
  await expect(page.getByTestId('mobile-agent-sheet')).toHaveAttribute('data-open', 'false');
});

test('[MOCK][mobile] Agent シートを閉じてもノート(editor)が背面に残る (AC-6-2)', async ({ page }) => {
  await openMobileApp(page);
  await page.route('**/api/health', (route) => {
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }),
    );
  });

  await page.getByTestId('mobile-nav-agent').click();
  await page.getByTestId('mobile-agent-sheet-close').click();

  // エディタが消えていないことを確認
  await expect(page.getByTestId('editor')).toBeVisible();
});

test('[MOCK][mobile] 閉じた Agent シートがビューポート外に完全に隠れてボトムナビを覆わない (bug fix)', async ({ page }) => {
  await openMobileApp(page);
  await page.route('**/api/health', (route) => {
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }),
    );
  });

  // シートが閉じている状態でのチェック (デフォルト)
  const sheet = page.getByTestId('mobile-agent-sheet');
  await expect(sheet).toHaveAttribute('data-open', 'false');

  // シートのバウンディングボックスがビューポート下端より下にあること
  // (完全にオフスクリーン = ビューポート高さより大きい y 座標)
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (viewport !== null) {
    const sheetBox = await sheet.boundingBox();
    // シートが存在する場合、その top が viewport 高さ以上 (完全にオフスクリーン)
    if (sheetBox !== null) {
      expect(sheetBox.y).toBeGreaterThanOrEqual(viewport.height);
    }
  }

  // ボトムナビとその 3 アイテムがすべて完全に表示されること
  const nav = page.getByTestId('mobile-bottom-nav');
  await expect(nav).toBeVisible();

  const navBox = await nav.boundingBox();
  expect(navBox).not.toBeNull();

  for (const testid of ['mobile-nav-notes', 'mobile-nav-search', 'mobile-nav-agent']) {
    await expect(page.getByTestId(testid)).toBeVisible();
  }
});

test('[MOCK][mobile] Agent シートを開いてから閉じるとボトムナビが再び完全表示される', async ({ page }) => {
  await openMobileApp(page);
  await page.route('**/api/health', (route) => {
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }),
    );
  });

  // 開く
  await page.getByTestId('mobile-nav-agent').click();
  await expect(page.getByTestId('mobile-agent-sheet')).toHaveAttribute('data-open', 'true');

  // 閉じる
  await page.getByTestId('mobile-agent-sheet-close').click();
  await expect(page.getByTestId('mobile-agent-sheet')).toHaveAttribute('data-open', 'false');

  // ボトムナビが表示されていること
  await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible();
  await expect(page.getByTestId('mobile-nav-notes')).toBeVisible();
  await expect(page.getByTestId('mobile-nav-search')).toBeVisible();
  await expect(page.getByTestId('mobile-nav-agent')).toBeVisible();
});
