/**
 * Story S79c210-4 E2E — パンくず (route-display) が内部ルート接頭辞 /n/ を露出しない。
 *
 * 実ブラウザ → 実 Vite → 実サーバー (test-discipline Rule 2/4)。フォルダ配下のノートを
 * API で作成して開き、パンくずがフォルダ階層 + ノート名で構成され、生の `/n/` トークンを
 * 見せないことを検証する。URL (/n/{path}) 自体は維持される。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const FOLDER = 'bc-folder-e2e';
const NOTE = `${FOLDER}/ノートBC.md`;

async function putNote(rel: string, content: string): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/notes/${encodeURIComponent(rel)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`putNote ${rel} failed: ${String(res.status)}`);
}

test('[AC-S79c210-4-1] パンくずは /n/ を露出せず、フォルダ階層 + ノート名で表示する', async ({
  page,
}) => {
  await putNote(NOTE, '# ノートBC\n\n本文BC です。\n');

  // URL 直開き (/n/{path}) で着地させる — URL 自体は /n/ を維持する
  await page.goto(`${state().uiUrl}/n/${FOLDER}/${encodeURIComponent('ノートBC')}`);
  await expect(page.getByTestId('editor')).toContainText('本文BC');
  await expect(page).toHaveURL(/\/n\/bc-folder-e2e\//);

  const crumb = page.getByTestId('route-display');
  // フォルダ名とノート名は見える
  await expect(crumb).toContainText(FOLDER);
  await expect(crumb).toContainText('ノートBC');
  // 生の /n/ トークンは出さない (回帰防止)
  await expect(crumb).not.toContainText('/n/');
});
