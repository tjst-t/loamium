/**
 * mock テスト共通ヘルパー (page.route ベース)。
 * モックの形は packages/server/src/routes/*.ts の実レスポンス構造に一致させること。
 */
import type { Page, Route } from '@playwright/test';

export function json(body: unknown, status = 200): Parameters<Route['fulfill']>[0] {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

export interface PutBody {
  content: string;
  baseMtime?: number;
}

/**
 * 予期しない API 呼び出しを検出する catch-all。
 * 各テストはこれを最初に登録し (Playwright の route は後勝ち)、
 * テスト末尾で戻り値の配列が空であることを検証する。
 */
export async function installCatchAll(page: Page): Promise<string[]> {
  const unexpected: string[] = [];
  await page.route('**/api/**', (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    void route.fulfill(json({ error: 'unmocked', message: 'unmocked endpoint in mock test' }, 500));
  });
  return unexpected;
}
