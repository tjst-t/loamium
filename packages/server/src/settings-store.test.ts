/**
 * settings-store.ts のユニットテスト (Sa10026-3-1)。
 *
 * 実際のファイルシステムを使う (tmp ディレクトリを vault root として使用)。
 *
 * [AC-Sa10026-3-1] server が system/settings.yaml を型付きで読み書きし、
 *   無ければ既定値へフォールバック。壊れた YAML は寛容 read で既定に落ちる。
 * [AC-Sa10026-3-2] settings.yaml には端末依存フィールドを含めないことをスキーマで担保。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSettings, saveSettings } from './settings-store.js';
import {
  DEFAULT_APP_SETTINGS,
  appSettingsSchema,
  type AppSettings,
} from '@loamium/shared';

// ---- テスト用 vault を tmp に作る ----

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loamium-settings-test-'));
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

/** vault 内に相対パスでファイルを書く */
async function writeVault(relPath: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

// ---- loadSettings ----

describe('loadSettings [AC-Sa10026-3-1]', () => {
  it('system/settings.yaml が存在しない場合は既定値を返す', async () => {
    const settings = await loadSettings(vaultRoot);
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('正常な YAML を読み込んで返す', async () => {
    await writeVault(
      'system/settings.yaml',
      'theme: dark\ndefaultFolder: "projects"\njournalTemplate: "system/templates/journal.md"\nshowSystemFolder: true\n',
    );
    const settings = await loadSettings(vaultRoot);
    expect(settings.theme).toBe('dark');
    expect(settings.defaultFolder).toBe('projects');
    expect(settings.showSystemFolder).toBe(true);
  });

  it('一部フィールドのみの YAML は残りを既定値で補う', async () => {
    await writeVault('system/settings.yaml', 'theme: light\n');
    const settings = await loadSettings(vaultRoot);
    expect(settings.theme).toBe('light');
    expect(settings.defaultFolder).toBe('');
    expect(settings.journalTemplate).toBe('system/templates/journal.md');
    expect(settings.showSystemFolder).toBe(false);
  });

  it('壊れた YAML は寛容 read で既定値にフォールバックする [AC-Sa10026-3-1]', async () => {
    await writeVault('system/settings.yaml', '{ broken: [yaml: : ::\n');
    const settings = await loadSettings(vaultRoot);
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('空ファイルは既定値を返す', async () => {
    await writeVault('system/settings.yaml', '');
    const settings = await loadSettings(vaultRoot);
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('YAML が --- のみ (空ドキュメント) の場合は既定値を返す', async () => {
    await writeVault('system/settings.yaml', '---\n');
    const settings = await loadSettings(vaultRoot);
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('YAML が配列の場合は既定値を返す', async () => {
    await writeVault('system/settings.yaml', '- theme: dark\n- theme: light\n');
    const settings = await loadSettings(vaultRoot);
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('未知フィールド (passthrough) が含まれていても既知フィールドは正しく読む', async () => {
    await writeVault(
      'system/settings.yaml',
      'theme: dark\nfutureField: someValue\nshowSystemFolder: true\n',
    );
    const settings = await loadSettings(vaultRoot);
    expect(settings.theme).toBe('dark');
    expect(settings.showSystemFolder).toBe(true);
    // passthrough: 未知フィールドも残っている
    expect((settings as Record<string, unknown>)['futureField']).toBe('someValue');
  });
});

// ---- saveSettings ----

describe('saveSettings [AC-Sa10026-3-1]', () => {
  it('system/ ディレクトリが存在しなくても自動作成して保存する', async () => {
    const settings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      theme: 'dark',
    };
    const result = await saveSettings(vaultRoot, settings);
    expect(result.created).toBe(true);
    expect(result.mtime).toBeGreaterThan(0);

    // 書き込んだ内容を読み返す
    const loaded = await loadSettings(vaultRoot);
    expect(loaded.theme).toBe('dark');
  });

  it('既存ファイルを上書きすると created: false を返す', async () => {
    const settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
    await saveSettings(vaultRoot, settings);

    const updated: AppSettings = { ...DEFAULT_APP_SETTINGS, theme: 'light' };
    const result = await saveSettings(vaultRoot, updated);
    expect(result.created).toBe(false);

    const loaded = await loadSettings(vaultRoot);
    expect(loaded.theme).toBe('light');
  });

  it('書き込んだ YAML を loadSettings で round-trip できる', async () => {
    const original: AppSettings = {
      theme: 'dark',
      defaultFolder: 'projects/2026',
      journalTemplate: 'system/templates/daily.md',
      showSystemFolder: true,
    };
    await saveSettings(vaultRoot, original);
    const loaded = await loadSettings(vaultRoot);
    expect(loaded.theme).toBe(original.theme);
    expect(loaded.defaultFolder).toBe(original.defaultFolder);
    expect(loaded.journalTemplate).toBe(original.journalTemplate);
    expect(loaded.showSystemFolder).toBe(original.showSystemFolder);
  });

  it('保存ファイルは UTF-8 / LF 改行である', async () => {
    const settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
    await saveSettings(vaultRoot, settings);
    const abs = path.join(vaultRoot, 'system/settings.yaml');
    const raw = await fs.readFile(abs, 'utf8');
    expect(raw).not.toMatch(/\r/); // CRLF なし
  });
});

// ---- 境界原則 (AC-Sa10026-3-2): スキーマに端末依存フィールドを含まない ----

describe('appSettingsSchema boundary [AC-Sa10026-3-2]', () => {
  it('スキーマのキーに端末依存フィールドが含まれない', () => {
    // appSettingsSchema.shape には端末固有・再構築可能な状態フィールドが存在しないことを確認する。
    // これらは .loamium/ に残す (ADR-0010 境界原則)。
    const terminalDependentFields = [
      'lastOpenedNote',
      'lastOpenNote',
      'recentNotes',
      'paneWidth',
      'sidebarWidth',
      'searchIndexCache',
      'indexCache',
      'windowSize',
      'windowPosition',
    ];

    // appSettingsSchema は passthrough() を持つが shape にあるキーを確認する
    const schemaShape = appSettingsSchema.shape;
    const schemaKeys = Object.keys(schemaShape);

    for (const field of terminalDependentFields) {
      expect(schemaKeys).not.toContain(field);
    }
  });

  it('スキーマが持つフィールドは移植可能・git 追跡可能な設定のみ', () => {
    const schemaShape = appSettingsSchema.shape;
    const schemaKeys = Object.keys(schemaShape);
    // 現在定義されているフィールドのみ (theme / defaultFolder / journalTemplate / showSystemFolder)
    expect(schemaKeys).toContain('theme');
    expect(schemaKeys).toContain('defaultFolder');
    expect(schemaKeys).toContain('journalTemplate');
    expect(schemaKeys).toContain('showSystemFolder');
    // 境界確認: 端末依存フィールドは存在しない (スキーマに追加した場合はここで検出される)
    expect(schemaKeys.length).toBe(4);
  });
});
