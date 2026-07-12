/**
 * コマンドレジストリ (Sde7a63-1)。
 *
 * registries.ts のパターンを踏襲した Map ベースの singleton。
 * 組み込みコマンド (source='builtin') はモジュールロード時に builtinCommands.ts が登録する。
 * スマートコマンド (source='smart') は Story 3 (Sde7a63-3) がレジストリに追加する。
 */

/** パレットの一コマンド。 */
export interface CommandEntry {
  /** 一意 ID (例: 'new-note', 'open-today-journal')。 */
  id: string;
  /** パレットに表示するタイトル。 */
  title: string;
  /** フィルタに使うキーワード一覧 (title に含まれないワードを補う)。 */
  keywords: string[];
  /** コマンド行左端のアイコン (JSX 要素)。 */
  icon: React.ReactNode;
  /** 組み込み or スマートコマンド。data-source 属性にも反映される。 */
  source: 'builtin' | 'smart';
  /**
   * valid:false のスマートコマンド向け: 選択不可 (data-disabled='true' + aria-disabled)。
   * 省略時は false (選択可能)。
   */
  disabled?: boolean;
  /** disabled=true 時のエラー理由テキスト (command-item-error-reason に表示)。 */
  errorReason?: string;
  /** コマンドを実行する関数。パレットを閉じてから呼ばれる。disabled=true の場合は呼ばれない。 */
  run: () => void;
}

// React を import しないと JSX が通らないが、icon は呼び出し元 (builtinCommands.ts) が
// 渡す ReactNode なのでここではインポートしない。型のみ参照できれば十分。
import type React from 'react';

const registry = new Map<string, CommandEntry>();

/** コマンドをレジストリに登録する (同 ID で再登録すると上書き)。 */
export function registerCommand(entry: CommandEntry): void {
  registry.set(entry.id, entry);
}

/** 現在登録されている全コマンドを登録順で返す。 */
export function getCommands(): CommandEntry[] {
  return Array.from(registry.values());
}

/**
 * レジストリをクリアする。
 * テストで状態をリセットするために使う (clearRegistry という名にすることで
 * registries.ts のパターンと対称になる)。
 */
export function clearRegistry(): void {
  registry.clear();
}
