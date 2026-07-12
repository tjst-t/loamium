/**
 * base システムプロンプトのテスト (S10a31c-1 / ADR-0010)。
 *
 * AC-S10a31c-1-1: Loamium がコードで生成した base システムプロンプトが pi セッションに
 *   注入される (createPiSession / openPiSession の両経路で resourceLoader を配線)。
 * AC-S10a31c-1-2: base プロンプトに必須文言が含まれ、DQL/テンプレート/DataView 等の
 *   詳細な使い方は含まれない。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentSystemPrompt } from './agent-prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('buildAgentSystemPrompt', () => {
  const prompt = buildAgentSystemPrompt();

  // ---- AC-S10a31c-1-2: 必須文言の存在 ------------------------------------------

  it('[AC-S10a31c-1-2] 役割 (この vault の読み書きノート補助) が明文で含まれる', () => {
    expect(prompt).toMatch(/vault/);
    expect(prompt).toMatch(/読み書き|補助/);
    expect(prompt).toMatch(/ノート/);
  });

  it('[AC-S10a31c-1-2] ピュア Markdown の制約が明文で含まれる', () => {
    expect(prompt).toMatch(/ピュア Markdown/);
    // ブロック ID・独自記法を書き込まない旨
    expect(prompt).toMatch(/ブロック ID|独自記法/);
  });

  it('[AC-S10a31c-1-2] [[リンク]] による出典明示が明文で含まれる', () => {
    expect(prompt).toContain('[[リンク]]');
    expect(prompt).toMatch(/出典/);
  });

  it('[AC-S10a31c-1-2] 与えられたツールのみ使用が明文で含まれる', () => {
    expect(prompt).toMatch(/与えられたツールのみ|提供されていない操作/);
  });

  it('[AC-S10a31c-1-2] 権限と機密領域の尊重が明文で含まれる', () => {
    expect(prompt).toMatch(/権限/);
    expect(prompt).toMatch(/機密/);
  });

  it('[AC-S10a31c-1-2] 日本語で簡潔に、という出力スタイルが明文で含まれる', () => {
    expect(prompt).toMatch(/日本語/);
    expect(prompt).toMatch(/簡潔/);
  });

  // ---- AC-S10a31c-1-2: 詳細知識が含まれないこと --------------------------------
  //
  // DQL 文法の具体・DataView フェンス・テンプレートの詳細な使い方は help ツールが供給する。
  // base プロンプトに漏れ込んでいないことを回帰防止としてアサートする。

  it('[AC-S10a31c-1-2] DQL 文法の具体 (LIST/TABLE/TASK/FROM/WHERE) を含まない', () => {
    expect(prompt).not.toMatch(/\bLIST\b/);
    expect(prompt).not.toMatch(/\bTABLE\b/);
    expect(prompt).not.toMatch(/\bTASK\b/);
    expect(prompt).not.toMatch(/\bWHERE\b/);
    expect(prompt).not.toMatch(/\bFROM\b/);
    expect(prompt).not.toMatch(/DQL/);
  });

  it('[AC-S10a31c-1-2] DataView / テンプレートの詳細やフェンス例を含まない', () => {
    expect(prompt).not.toMatch(/DataView/i);
    expect(prompt).not.toMatch(/dataview/);
    expect(prompt).not.toMatch(/```/); // コードフェンス例を持ち込まない
    expect(prompt).not.toMatch(/frontmatter|フロントマター/);
    expect(prompt).not.toMatch(/ジャーナル|journal/);
  });

  it('純関数として毎回同じ文字列を返す', () => {
    expect(buildAgentSystemPrompt()).toBe(prompt);
  });
});

// ---- AC-S10a31c-1-1: agent-service が resourceLoader を配線している ------------
//
// createAgentSession への配線は model/API 等の外部依存が必要でユニット化しにくいため、
// (1) agent-service のソースが buildAgentSystemPrompt を import し resourceLoader を渡す
//     配線をしていること、(2) pi SDK の DefaultResourceLoader を base プロンプトで
//     構築したとき getSystemPrompt() が base を返すこと、の 2 点で担保する。

describe('base システムプロンプトの注入配線 (AC-S10a31c-1-1)', () => {
  it('[AC-S10a31c-1-1] agent-service が buildAgentSystemPrompt を使い resourceLoader を配線している', () => {
    const src = readFileSync(path.join(here, 'agent-service.ts'), 'utf8');
    expect(src).toContain('buildAgentSystemPrompt');
    // createAgentSession の両経路で resourceLoader が渡されていること
    expect(src).toContain('resourceLoader');
    const resourceLoaderWirings = src.match(/resourceLoader,/g) ?? [];
    // createPiSession / openPiSession の 2 経路で渡す
    expect(resourceLoaderWirings.length).toBeGreaterThanOrEqual(2);
  });

  it('[AC-S10a31c-1-1] DefaultResourceLoader を base プロンプトで構築すると getSystemPrompt() が base を返す', async () => {
    const { DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
    const base = buildAgentSystemPrompt();
    const loader = new DefaultResourceLoader({
      cwd: here,
      agentDir: path.join(here, '__does_not_exist__'),
      systemPrompt: base,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getSystemPrompt()).toBe(base);
  });
});
