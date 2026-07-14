/**
 * SystemFolderSection — system/ フォルダ表示トグルと定義ファイル一覧 (Sa10026-4)。
 *
 * - tree-system-toggle: クリックで system/ ツリーの表示/非表示を切り替える。
 * - tree-system セクション: system/smart-folders / system/templates / system/commands /
 *   system/settings.yaml をサブフォルダ別グループで表示。
 * - ドラッグ&ドロップで同一サブフォルダ内の order: を安定ソートで再採番し
 *   PUT /api/notes/{path} で永続する。
 *
 * 設計上の判断:
 * - NoteMeta に order フィールドがないため、ドラッグ&ドロップ前は path の辞書順で表示する。
 *   ドラッグ&ドロップ後に各ファイルを GET して order を読み書きする。
 * - system/ 配下の定義ファイルはクリックで編集エディタで開く(プレビューでなく)。
 *   onOpenNote(path) → App.loadNote → Editor 表示。
 * - サーバは全件返す(クライアントフィルタ)。フィルタは App.tsx 側で行う。
 */
import { useRef, useState, type JSX, type DragEvent } from 'react';
import type { NoteMeta } from '@loamium/shared';
import { ChevronRightIcon } from '../icons.js';
import { api } from '../api.js';

export interface SystemFolderSectionProps {
  /** server から返った全 notes (system/ 含む)。null = 未ロード。 */
  notes: NoteMeta[] | null;
  /** system/ 表示中かどうか */
  shown: boolean;
  /** トグルクリックハンドラ */
  onToggle: () => void;
  /** ファイルクリックで Editor を開くハンドラ */
  onOpenNote: (path: string) => void;
}

// system/ 配下のサブフォルダグループ定義 (表示順)
const SYSTEM_GROUPS = [
  { prefix: 'system/smart-folders/', label: 'smart-folders' },
  { prefix: 'system/templates/', label: 'templates' },
  { prefix: 'system/commands/', label: 'commands' },
] as const;

const SETTINGS_PATH = 'system/settings.yaml';

/**
 * YAML ファイルの order: キーを書き換える。
 * 既存の `order: <n>` 行を置換、なければ先頭に追加する。
 */
function replaceYamlOrder(content: string, newOrder: number): string {
  const orderLine = `order: ${newOrder}`;
  // NOTE: /^order:\s*\S+/m は \s が \n を含むため行をまたいでしまう。
  // /^order:.*$/m で同一行内のみ置換する。
  if (/^order:.*$/m.test(content)) {
    return content.replace(/^order:.*$/m, orderLine);
  }
  return `${orderLine}\n${content}`;
}

/**
 * Markdown frontmatter の order: フィールドを書き換える。
 * `---\n...\n---` ブロック内を更新、なければ frontmatter を追加する。
 */
function replaceMdOrder(content: string, newOrder: number): string {
  const fmRe = /^---\n([\s\S]*?)\n---/;
  const m = fmRe.exec(content);
  if (m !== null && m[1] !== undefined) {
    const innerFm: string = m[1];
    const orderLine = `order: ${newOrder}`;
    let newInner: string;
    if (/^order:.*$/m.test(innerFm)) {
      newInner = innerFm.replace(/^order:.*$/m, orderLine);
    } else {
      newInner = `${innerFm}\n${orderLine}`;
    }
    return content.replace(fmRe, `---\n${newInner}\n---`);
  }
  // frontmatter なし → 追加
  return `---\norder: ${newOrder}\n---\n${content}`;
}

function updateOrderInContent(path: string, content: string, newOrder: number): string {
  if (path.endsWith('.md')) return replaceMdOrder(content, newOrder);
  return replaceYamlOrder(content, newOrder);
}

interface DragState {
  srcPath: string;
  overPath: string | null;
  position: 'before' | 'after' | null;
}

interface GroupProps {
  label: string;
  items: NoteMeta[];
  onOpenNote: (path: string) => void;
  onReorder: (reordered: NoteMeta[]) => void;
}

function SystemGroup({ label, items, onOpenNote, onReorder }: GroupProps): JSX.Element {
  const [localOrder, setLocalOrder] = useState<NoteMeta[]>(items);
  const [drag, setDrag] = useState<DragState | null>(null);

  // items が変化したら localOrder をリセット
  const prevItemsRef = useRef<NoteMeta[]>(items);
  if (prevItemsRef.current !== items) {
    prevItemsRef.current = items;
    setLocalOrder(items);
  }

  const handleDragStart = (path: string) => (e: DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    setDrag({ srcPath: path, overPath: null, position: null });
  };

  const handleDragOver = (path: string) => (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drag === null || drag.srcPath === path) return;
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';
    if (drag.overPath !== path || drag.position !== position) {
      setDrag((d) => (d !== null ? { ...d, overPath: path, position } : d));
    }
  };

  const handleDragLeave = () => {
    setDrag((d) => (d !== null ? { ...d, overPath: null, position: null } : d));
  };

  const handleDrop = (targetPath: string) => (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (drag === null || drag.srcPath === targetPath) {
      setDrag(null);
      return;
    }
    const src = drag.srcPath;
    const position = drag.position ?? 'after';
    setDrag(null);

    const srcItem = localOrder.find((n) => n.path === src);
    if (srcItem === undefined) return;

    const without = localOrder.filter((n) => n.path !== src);
    const insertAt = without.findIndex((n) => n.path === targetPath);
    if (insertAt < 0) return;
    const finalInsert = position === 'before' ? insertAt : insertAt + 1;
    const reordered = [...without];
    reordered.splice(finalInsert, 0, srcItem);

    setLocalOrder(reordered);
    onReorder(reordered);
  };

  const handleDragEnd = () => {
    setDrag(null);
  };

  return (
    <div data-testid={`tree-system-group-${label}`}>
      <div className="tree-group-label" data-testid={`tree-system-group-label-${label}`}>
        {label}
      </div>
      {localOrder.map((note) => {
        const isOver = drag?.overPath === note.path;
        const dropBefore = isOver && drag?.position === 'before';
        const dropAfter = isOver && drag?.position === 'after';
        const isDragging = drag?.srcPath === note.path;
        const fileName = note.path.split('/').at(-1) ?? note.path;
        return (
          <button
            key={note.path}
            className={`tree-item${isDragging ? ' dragging' : ''}`}
            data-testid="tree-item"
            data-path={note.path}
            draggable
            style={
              dropBefore
                ? { borderTop: '2px solid var(--accent)' }
                : dropAfter
                  ? { borderBottom: '2px solid var(--accent)' }
                  : undefined
            }
            onClick={() => onOpenNote(note.path)}
            onDragStart={handleDragStart(note.path)}
            onDragOver={handleDragOver(note.path)}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop(note.path)}
            onDragEnd={handleDragEnd}
          >
            <span className="name">{fileName}</span>
            <span className="drag-handle" aria-hidden="true">⠿</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * ドラッグ&ドロップ後の order 再採番と PUT 永続。
 * reordered は新しい並び順の NoteMeta[]。
 * 10 刻みで order: を付与し直し、各ファイルを GET → PUT する。
 */
function persistOrder(reordered: NoteMeta[]): void {
  reordered.forEach((note, idx) => {
    const newOrder = (idx + 1) * 10;
    void (async () => {
      try {
        const res = await api.getNote(note.path);
        const newContent = updateOrderInContent(note.path, res.content, newOrder);
        await api.putNote(note.path, newContent, res.mtime);
      } catch (err) {
        console.error('[loamium] system order rewrite failed for', note.path, err);
      }
    })();
  });
}

export function SystemFolderSection({
  notes,
  shown,
  onToggle,
  onOpenNote,
}: SystemFolderSectionProps): JSX.Element {
  // system/ 配下のファイルをサブフォルダごとに分類 (path の辞書順)
  const systemNotes = (notes ?? [])
    .filter((n) => n.folder.startsWith('system'))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 各グループのファイル一覧
  const groups = SYSTEM_GROUPS.map(({ prefix, label }) => ({
    label,
    items: systemNotes.filter((n) => n.path.startsWith(prefix)),
  })).filter((g) => g.items.length > 0);

  // settings.yaml は別扱い (単体・order なし)
  const settingsNote = systemNotes.find((n) => n.path === SETTINGS_PATH);

  return (
    <>
      {/* system/ 表示トグル */}
      <button
        className="tree-system-toggle"
        data-testid="tree-system-toggle"
        data-state={shown ? 'shown' : 'hidden'}
        aria-expanded={shown}
        onClick={onToggle}
      >
        <ChevronRightIcon className="chev" />
        <span className="lbl">
          設定フォルダ{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>system/</code>
        </span>
        <span className="state" data-testid="tree-system-state">
          {shown ? '表示中' : '非表示'}
        </span>
      </button>

      {/* system/ ファイル一覧 */}
      {shown && (
        <div className="tree-system shown" data-testid="tree-system">
          {groups.map(({ label, items }) => (
            <SystemGroup
              key={label}
              label={label}
              items={items}
              onOpenNote={onOpenNote}
              onReorder={persistOrder}
            />
          ))}

          {settingsNote !== undefined && (
            <div data-testid="tree-system-group-settings">
              <div
                className="tree-group-label"
                data-testid="tree-system-group-label-settings"
              >
                settings.yaml
              </div>
              <button
                className="tree-item"
                data-testid="tree-item"
                data-path={settingsNote.path}
                onClick={() => onOpenNote(settingsNote.path)}
              >
                <span className="name">settings.yaml</span>
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
