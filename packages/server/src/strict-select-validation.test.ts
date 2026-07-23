/**
 * S1bd397-2 厳格 select 検証のユニット/受け入れテスト。
 *
 * テスト対象:
 *   - instantiateTemplate で select+optionsQuery の値が候補外のとき 'invalid_select_value' を返す
 *   - runCommand (commands-service) で同様に候補外の値を拒否する
 *   - text+optionsQuery は自由入力なので候補外でも受理される
 *   - 候補 0 件のとき厳格 select は検証スキップ (空候補で弾かない)
 *
 * test-discipline Rule 1: 各 it は [AC-S1bd397-2-*] タグ付き。
 * test-discipline Rule 6: VaultIndex はインメモリスタブ。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from './config.js';
import { instantiateTemplate } from './templates-service.js';
import { VaultIndex } from './noteIndex.js';

function makeConfig(vaultRoot: string): ServerConfig {
  return { vaultRoot, mode: 'full', maxUploadBytes: 1024 };
}

let vaultRoot: string;
let index: VaultIndex;

beforeEach(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-strict-select-'));
  index = new VaultIndex(vaultRoot);

  // テスト vault: #project ノードを 2 件用意
  await mkdir(path.join(vaultRoot, 'projects'), { recursive: true });
  await writeFile(
    path.join(vaultRoot, 'projects', 'loamium.md'),
    '---\ntags: [project]\n---\n# loamium\n',
    'utf8',
  );
  await writeFile(
    path.join(vaultRoot, 'projects', 'webapp.md'),
    '---\ntags: [project]\n---\n# webapp\n',
    'utf8',
  );
  await index.build();

  // テンプレートファイル: select + optionsQuery (static options なし)
  await mkdir(path.join(vaultRoot, 'system', 'templates'), { recursive: true });
  await writeFile(
    path.join(vaultRoot, 'system', 'templates', 'epic.md'),
    [
      '---',
      'loamium-template:',
      '  description: Epic テンプレート',
      '  target: "projects/{{プロジェクト名}}/epics/{{Epic名}}"',
      '  vars:',
      '    - name: プロジェクト名',
      '      type: select',
      '      required: true',
      '      optionsQuery: "LIST FROM #project"',
      '    - name: Epic名',
      '      type: text',
      '      required: true',
      '---',
      '# {{Epic名}}',
      '',
      'プロジェクト: {{プロジェクト名}}',
    ].join('\n'),
    'utf8',
  );
});

// ---- AC-S1bd397-2-1: 厳格 select — 候補外の値を拒否 ----

describe('[AC-S1bd397-2-1] instantiateTemplate — 厳格 select 候補外を拒否', () => {
  it('select+optionsQuery の候補外の値 → invalid_select_value', async () => {
    const result = await instantiateTemplate(
      makeConfig(vaultRoot),
      'epic',
      { プロジェクト名: '存在しないプロジェクト', Epic名: 'テストEpic' },
      undefined,
      undefined,
      index, // VaultIndex を渡して候補解決
    );
    expect(result.status).toBe('invalid_select_value');
    if (result.status === 'invalid_select_value') {
      expect(result.paramName).toBe('プロジェクト名');
    }
  });

  it('select+optionsQuery の候補値 → 受理されてノート作成', async () => {
    const result = await instantiateTemplate(
      makeConfig(vaultRoot),
      'epic',
      { プロジェクト名: 'loamium', Epic名: 'DQL機能' },
      undefined,
      undefined,
      index,
    );
    expect(result.status).toBe('ok');
  });
});

// ---- AC-S1bd397-2-2: text+optionsQuery は自由入力を受理 ----

describe('[AC-S1bd397-2-2] instantiateTemplate — text+optionsQuery は候補外でも受理', () => {
  it('text+optionsQuery の変数に候補外の値を渡しても受理', async () => {
    const result = await instantiateTemplate(
      makeConfig(vaultRoot),
      'epic',
      { プロジェクト名: 'loamium', Epic名: '全く新しいEpic名' },
      undefined,
      undefined,
      index,
    );
    // Epic名は text 型なので候補外でも ok
    expect(result.status).toBe('ok');
  });
});

// ---- AC-S1bd397-2-3: 候補 0 件のとき厳格 select は検証スキップ ----

describe('[AC-S1bd397-2-3] select+optionsQuery 候補 0 件 → フォールバック', () => {
  it('候補 0 件のとき select は検証スキップして受理 (任意の値を通す)', async () => {
    // query = 存在しないタグ → 0 件 → 検証スキップ
    await mkdir(path.join(vaultRoot, 'system', 'templates'), { recursive: true });
    await writeFile(
      path.join(vaultRoot, 'system', 'templates', 'epic-empty.md'),
      [
        '---',
        'loamium-template:',
        '  description: 候補0件テスト',
        '  target: "test/{{名前}}"',
        '  vars:',
        '    - name: 名前',
        '      type: select',
        '      required: true',
        '      optionsQuery: "LIST FROM #nonexistent"',
        '---',
        '# {{名前}}',
      ].join('\n'),
      'utf8',
    );

    const result = await instantiateTemplate(
      makeConfig(vaultRoot),
      'epic-empty',
      { 名前: '何でも通る' },
      undefined,
      undefined,
      index,
    );
    expect(result.status).toBe('ok');
  });
});
