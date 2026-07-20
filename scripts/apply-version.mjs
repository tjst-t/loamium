#!/usr/bin/env node
/**
 * CI 専用: git タグ由来のバージョンを各 package.json の version に反映する。
 *
 * 思想は「タグが唯一の入力」。リポジトリにコミットされた package.json は据え置き、
 * リリース成果物 (Docker / web tar.gz / Electron) にだけタグ準拠の version を焼き込む。
 * これにより手動の version bump も毎回の確認も不要になる。
 * 開発中のビルドでは使わない (UI はビルド時埋め込み / server health は git 非依存で解決)。
 *
 * 使い方: node scripts/apply-version.mjs <version>
 *   <version> は "v0.2.0" / "0.2.0" いずれも可 (先頭 v は除去)。
 *   空 / 未指定なら何もせず正常終了 (タグ以外のビルドで安全にスキップ)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raw = (process.argv[2] ?? '').trim();
if (raw === '') {
  console.log('apply-version: バージョン未指定 — スキップ');
  process.exit(0);
}

const version = raw.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+([-+].+)?$/.test(version)) {
  console.error(`apply-version: 不正なバージョン "${raw}"`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/ui/package.json',
  'packages/cli/package.json',
  'packages/app-electron/package.json',
  'packages/app-tauri/package.json',
];

for (const rel of targets) {
  const file = join(root, rel);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // 存在しない workspace はスキップ
  }
  const pkg = JSON.parse(text);
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`apply-version: ${rel} -> ${version}`);
}
