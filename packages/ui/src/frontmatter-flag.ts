/**
 * frontmatter の boolean フラグ (例: bookmark) を、開いているエディタの **バッファ** 上で
 * set/unset する編集を計算・適用する (Sxxx: 開いているファイルを編集する)。
 *
 * 背景: ヘッダの★ (BookmarkStar) は従来 POST /api/notes/{path}/properties で frontmatter を
 * **ディスクへ直接**書き、成功後にノートを再フェッチして editor 内容を丸ごと置換していた。
 * これは「開いているノートはバッファが正本」の原則に反し、未保存の編集を失う/カーソルを
 * リセットする実害があった。ここではバッファの frontmatter だけを差分編集し、通常の自動保存
 * フローで永続化する (タスクフィールド編集と同じ方式)。
 *
 * frontmatter モデル化は shared の parsePropertiesModel / serializeFrontmatterBlock を共有する
 * (プロパティウィジェットと同一)。モデル化できない frontmatter は触らない (null を返す)。
 */
import type { EditorView } from '@codemirror/view';
import {
  parsePropertiesModel,
  serializeFrontmatterBlock,
  type PropEntry,
} from '@loamium/shared';

export interface FlagEdit {
  from: number;
  to: number;
  insert: string;
}

/** frontmatter ブロックの char 範囲と内側 YAML を求める。無効/不在なら null。 */
function locateFrontmatter(
  text: string,
): { from: number; to: number; inner: string } | null {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').replace(/\r$/, '') === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return null; // 閉じ --- が無い = 不正 frontmatter → 触らない
  const inner = lines
    .slice(1, close)
    .map((l) => l.replace(/\r$/, ''))
    .join('\n');
  // 閉じ --- 行の終端 (改行の手前) の char offset
  let to = 0;
  for (let i = 0; i < close; i++) to += (lines[i] ?? '').length + 1; // +1 = \n
  to += (lines[close] ?? '').length;
  return { from: 0, to, inner };
}

/**
 * text の frontmatter に boolean フラグ key を set(next=true)/unset(next=false) した
 * バッファ編集 (from/to/insert) を返す。変更不要 / モデル化不能なら null。
 */
export function computeFrontmatterFlagEdit(
  text: string,
  key: string,
  next: boolean,
): FlagEdit | null {
  const fm = locateFrontmatter(text);

  if (fm !== null) {
    const parsed = parsePropertiesModel(fm.inner);
    if (parsed === null) return null; // モデル化不能 (ソース表示のまま) → 触らない
    const already = parsed.some((e) => 'key' in e && e.key === key);
    if (!next && !already) return null; // 既に無い → 何もしない
    const without = parsed.filter((e) => !('key' in e && e.key === key));
    if (next) without.push({ kind: 'scalar', key, value: true });
    const block = serializeFrontmatterBlock(without);
    if (block === null) {
      // キーを消したら空 frontmatter になった → ブロックごと除去 (直後の改行も1つ食う)
      let to = fm.to;
      if (text[to] === '\n') to += 1;
      return { from: 0, to, insert: '' };
    }
    return { from: fm.from, to: fm.to, insert: block };
  }

  // frontmatter 無し
  if (!next) return null; // 無いものを unset → 何もしない
  const block = serializeFrontmatterBlock([{ kind: 'scalar', key, value: true } as PropEntry]);
  if (block === null) return null;
  return { from: 0, to: 0, insert: `${block}\n` };
}

/**
 * 開いているエディタのバッファ frontmatter で boolean フラグ key を set/unset する。
 * 適用できたら true、変更不要/不能なら false。
 */
export function toggleFrontmatterFlag(view: EditorView, key: string, next: boolean): boolean {
  const edit = computeFrontmatterFlagEdit(view.state.doc.toString(), key, next);
  if (edit === null) return false;
  const changes = view.state.changes({ from: edit.from, to: edit.to, insert: edit.insert });
  view.dispatch({
    changes,
    // 追加/除去した frontmatter の **外**(本文側)にカーソルを残す (assoc +1)。frontmatter 内に
    // 残ると live-preview が生 YAML 表示になりプロパティウィジェットが出ないため。
    selection: view.state.selection.map(changes, 1),
    userEvent: 'input.toggle-frontmatter-flag',
  });
  return true;
}
