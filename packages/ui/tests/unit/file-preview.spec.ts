/**
 * 拡張子 → プレビュー種別ディスパッチの純粋ロジック (Sf53ad6-3)。
 * DOM を要する描画は Playwright (file-preview.mock/e2e.spec.ts) 側で検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  extensionOf,
  fileCategoryOf,
  formatSize,
  IMAGE_EXTENSIONS,
  TEXT_PREVIEW_EXTENSIONS,
} from '../../src/file-kind';
import { shikiLangOf, TEXT_PREVIEW_LINES } from '../../src/renderers/file-preview';
import { getEmbedFileRenderer } from '../../src/renderers/embed';
import { registerBuiltinRenderers } from '../../src/renderers/index';

describe('extensionOf / fileCategoryOf', () => {
  it('拡張子を小文字で返す (多段拡張子は最後のみ、ドットなしは null)', () => {
    expect(extensionOf('assets/photo.PNG')).toBe('png');
    expect(extensionOf('assets/backup.tar.zst')).toBe('zst');
    expect(extensionOf('Makefile')).toBeNull();
    expect(extensionOf('.env')).toBeNull(); // 先頭ドットは拡張子ではない
  });

  it('画像 / pdf / テキスト / その他に分類する (prototype のアイコン区分)', () => {
    expect(fileCategoryOf('assets/a.png')).toBe('image');
    expect(fileCategoryOf('assets/report.pdf')).toBe('pdf');
    expect(fileCategoryOf('assets/server.log')).toBe('text');
    expect(fileCategoryOf('assets/data.csv')).toBe('text');
    expect(fileCategoryOf('src/main.ts')).toBe('text');
    expect(fileCategoryOf('assets/backup.tar.zst')).toBe('other');
    expect(fileCategoryOf('bin/loamium')).toBe('other');
  });
});

describe('formatSize', () => {
  it('B / KB / MB / GB の人間可読表記 (prototype の 1.2 MB 相当)', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(4300)).toBe('4.2 KB');
    expect(formatSize(1258291)).toBe('1.2 MB');
    expect(formatSize(50 * 1024 * 1024)).toBe('50 MB');
    expect(formatSize(2 * 1024 ** 3)).toBe('2.0 GB');
  });
});

describe('shikiLangOf', () => {
  it('コード拡張子は Shiki 言語へ写像し、対応外は null (プレーン表示)', () => {
    expect(shikiLangOf('json')).toBe('json');
    expect(shikiLangOf('ts')).toBe('ts');
    expect(shikiLangOf('mjs')).toBe('js');
    expect(shikiLangOf('h')).toBe('c');
    expect(shikiLangOf('patch')).toBe('diff');
    expect(shikiLangOf('log')).toBeNull();
    expect(shikiLangOf('txt')).toBeNull();
    expect(shikiLangOf('csv')).toBeNull();
  });
});

describe('拡張子レジストリのディスパッチ (registerBuiltinRenderers 後)', () => {
  it('画像 / pdf / テキスト拡張子にレンダラーが登録され、未知拡張子は未登録 (= カード)', () => {
    registerBuiltinRenderers();
    for (const ext of IMAGE_EXTENSIONS) {
      expect(getEmbedFileRenderer(ext), ext).toBeDefined();
    }
    expect(getEmbedFileRenderer('pdf')).toBeDefined();
    for (const ext of TEXT_PREVIEW_EXTENSIONS) {
      expect(getEmbedFileRenderer(ext), ext).toBeDefined();
    }
    // md はレジストリ対象外 (transclusion 側で処理)、未知拡張子はカードに落ちる
    expect(getEmbedFileRenderer('md')).toBeUndefined();
    expect(getEmbedFileRenderer('zst')).toBeUndefined();
    expect(getEmbedFileRenderer('exe')).toBeUndefined();
  });

  it('テキストプレビューの行数上限は正の定数', () => {
    expect(TEXT_PREVIEW_LINES).toBeGreaterThan(0);
  });
});
