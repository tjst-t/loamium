/**
 * ブックマークスター — ノートヘッダ右端 (S8086d9-2)。
 *
 * - data-bookmarked='true'|'false' で状態を表す (テスト契約)。
 * - クリックで **開いているエディタのバッファ** の frontmatter を直接編集する (onToggle)。
 *   ディスクへの直接書き込み (旧 POST /api/notes/{path}/properties) は行わない。永続化は
 *   通常の自動保存フローに委ねる。これにより未保存の編集を失わず、エディタもリセットされない
 *   (「開いているファイルを編集する」— タスクフィールド編集と同じ方式)。
 * - read-only / append-only モード (GET /api/health) では aria-disabled='true' で
 *   非インタラクティブにする。
 * - key={docPath} でマウントされるので、ノート切替時に状態がリセットされる。
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import type { PermissionMode } from '@loamium/shared';
import { api } from '../api.js';
import { StarFilledIcon, StarOutlineIcon } from '../icons.js';

export interface BookmarkStarProps {
  /** 初回表示時の frontmatter (サーバーから取得済み) */
  initialFrontmatter: Record<string, unknown> | null;
  /**
   * ★ トグル時に呼ばれる。開いているエディタバッファの frontmatter で `bookmark` を
   * set(next=true)/unset(next=false) し、適用できたら true を返す
   * (エディタ未接続 / モデル化できない frontmatter では false)。
   */
  onToggle: (next: boolean) => boolean;
}

export function BookmarkStar({ initialFrontmatter, onToggle }: BookmarkStarProps): JSX.Element {
  const [bookmarked, setBookmarked] = useState<boolean>(
    Boolean(initialFrontmatter?.bookmark),
  );
  /** null = health 取得中 */
  const [mode, setMode] = useState<PermissionMode | null>(null);

  // マウント時に health を 1 回取得してモードを確定する
  useEffect(() => {
    let cancelled = false;
    api.getHealth().then(
      (res) => {
        if (!cancelled) setMode(res.mode);
      },
      () => {
        // health 取得失敗時はフルモードとして扱う (楽観的フォールバック)
        if (!cancelled) setMode('full');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClick = useCallback((): void => {
    // read-only / append-only は書込不可なのでクリックを無視
    if (mode !== null && mode !== 'full') return;

    const next = !bookmarked;
    // 開いているノートのバッファ frontmatter を編集する。適用できたときだけ状態を更新する
    // (同期処理なのでロールバックは不要)。
    if (onToggle(next)) setBookmarked(next);
  }, [mode, bookmarked, onToggle]);

  const disabled = mode !== null && mode !== 'full';

  return (
    <button
      data-testid="bookmark-star"
      data-bookmarked={bookmarked ? 'true' : 'false'}
      aria-disabled={disabled ? 'true' : undefined}
      aria-label={bookmarked ? 'ブックマークを解除' : 'ブックマークに追加'}
      className={`bookmark-star icon-btn${bookmarked ? ' is-bookmarked' : ''}`}
      title={bookmarked ? 'ブックマークを解除' : 'ブックマークに追加'}
      onClick={disabled ? undefined : handleClick}
    >
      {bookmarked ? <StarFilledIcon /> : <StarOutlineIcon />}
    </button>
  );
}
