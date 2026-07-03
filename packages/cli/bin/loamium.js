#!/usr/bin/env node
// loamium CLI の bin エントリ。
// TS ソース直配布方針 (CLAUDE.md) に合わせ、tsx のランタイム登録で
// src/main.ts をビルドなしに実行する。tsx は @loamium/cli の依存に含まれる。
import { register } from 'tsx/esm/api';

register();
await import(new URL('../src/main.ts', import.meta.url).href);
