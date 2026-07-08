/**
 * ブックマークスター — ノートヘッダ右端 (S8086d9-2)。
 *
 * - data-bookmarked='true'|'false' で状態を表す (テスト契約)。
 * - クリックで POST /api/notes/{path}/properties を送り楽観更新する。
 *   API 失敗時は元の状態へロールバック。
 * - read-only / append-only モード (GET /api/health) では aria-disabled='true' で
 *   非インタラクティブにする。
 * - key={docPath} でマウントされるので、ノート切替時に状態がリセットされる。
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import type { PermissionMode, NotePropertyWriteRequest } from '@loamium/shared';
import { api } from '../api.js';
import { StarFilledIcon, StarOutlineIcon } from '../icons.js';

export interface BookmarkStarProps {
  /** 現在開いているノートの vault 相対パス */
  docPath: string;
  /** 初回表示時の frontmatter (サーバーから取得済み) */
  initialFrontmatter: Record<string, unknown> | null;
  /** ブックマーク操作成功後に呼ばれるコールバック (editor content の同期用) */
  onChanged?: () => void;
}

export function BookmarkStar({ docPath, initialFrontmatter, onChanged }: BookmarkStarProps): JSX.Element {
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

    const prev = bookmarked;
    const next = !prev;
    setBookmarked(next); // 楽観更新

    const body: NotePropertyWriteRequest = next
      ? { set: { bookmark: true } }
      : { unset: ['bookmark'] };

    api.setNoteProperties(docPath, body).then(
      (res) => {
        // サーバー応答の frontmatter で確定
        setBookmarked(Boolean(res.frontmatter?.bookmark));
        // 成功後: 呼び出し元 (App) にエディタ内容の再取得を依頼する
        onChanged?.();
      },
      () => {
        // 失敗時はロールバック
        setBookmarked(prev);
      },
    );
  }, [mode, bookmarked, docPath]);

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
