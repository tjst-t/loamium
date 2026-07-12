/**
 * グローバル検索 + コマンドパレット (Sbd061c-1 / Sde7a63-1 / prototype/)。
 *
 * - ノート名セクション: 表示時に GET /api/notes を再取得し、クライアント側で
 *   NFC 正規化 + 大文字小文字不区別の部分一致 (タイトル / パス) フィルタ (decisions I1)。
 *   エージェントが外部で作ったノートも開くたびに対象になる。
 * - 全文セクション: 200ms デバウンスで GET /api/search。line が null の結果
 *   (タイトルのみ一致) はノート名セクションと重複するため出さない (decisions I2)。
 * - コマンドセクション (Sde7a63-1): getCommands() からクエリで絞り込み。
 *   空クエリでも全コマンドを表示する (edge: empty query shows commands)。
 * - IME: compositionstart〜compositionend 間は全文検索を確定しない (decisions I3)。
 * - Esc / 外側クリックで閉じる。↑↓ で選択、Enter / クリックで開く。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CompositionEvent,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { NoteMeta, SearchResult } from '@loamium/shared';
import { api, ApiError } from '../api.js';
import { FileIcon, SearchIcon } from '../icons.js';
import { getCommands, type CommandEntry } from '../commandRegistry.js';
import { registerBuiltinCommands } from '../builtinCommands.js';
import type { BuiltinCommandHandlers } from '../builtinCommands.js';

const SEARCH_DEBOUNCE_MS = 200;
const MAX_NOTE_MATCHES = 20;

export interface SearchPaletteProps {
  onClose: () => void;
  /** ノート名一致の候補確定 — 対象ノートを開く */
  onOpenNote: (path: string) => void;
  /** 全文ヒットの候補確定 — 対象ノートを開き該当行 (1 始まり) へカーソル移動 */
  onOpenNoteAtLine: (path: string, line: number) => void;
  /** 詳細検索ページ (/search) を現在の入力を引き継いで開く (S935867-1 — 2 モード共存) */
  onOpenAdvanced: (query: string) => void;
  /** Sde7a63-1: 組み込みコマンド用ハンドラ。未指定時はコマンドセクションを省略しない (互換)。 */
  commandHandlers?: BuiltinCommandHandlers;
}

export type { BuiltinCommandHandlers };

interface FulltextHit extends SearchResult {
  line: number;
}

type PaletteItem =
  | { kind: 'note'; path: string; title: string }
  | { kind: 'fulltext'; hit: FulltextHit }
  | { kind: 'command'; entry: CommandEntry };

function normalize(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/** query の最初の一致箇所を <mark> で強調する (prototype の mark 契約)。 */
function highlight(text: string, query: string): ReactNode {
  const q = normalize(query);
  if (q.length === 0) return text;
  const idx = normalize(text).indexOf(q);
  // NFC 正規化で文字数が変わる文字列は位置がずれうるため、その場合は強調なしで返す
  if (idx === -1 || idx + q.length > text.length) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function matchNotes(notes: NoteMeta[], query: string): NoteMeta[] {
  const q = normalize(query.trim());
  if (q.length === 0) return [];
  const titleHits: NoteMeta[] = [];
  const pathHits: NoteMeta[] = [];
  for (const n of notes) {
    if (normalize(n.title).includes(q)) titleHits.push(n);
    else if (normalize(n.path).includes(q)) pathHits.push(n);
  }
  return [...titleHits, ...pathHits].slice(0, MAX_NOTE_MATCHES);
}

export function SearchPalette({
  onClose,
  onOpenNote,
  onOpenNoteAtLine,
  onOpenAdvanced,
  commandHandlers,
}: SearchPaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [fulltext, setFulltext] = useState<FulltextHit[]>([]);
  /** 全文検索を完了した最後のクエリ (空結果表示のゲート — デバウンス中のフリッカー防止) */
  const [searchedQuery, setSearchedQuery] = useState('');
  /** GET /api/search の失敗。検索成功でクリアされる */
  const [searchError, setSearchError] = useState<string | null>(null);
  /** GET /api/notes (ノート名セクション) の失敗。検索成功では消さない (レビュー R2) */
  const [notesError, setNotesError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  /** コマンドセクション: handlers が揃ったら組み込みコマンドを登録 */
  const [commands, setCommands] = useState<CommandEntry[]>([]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

  // 表示時にノート一覧を再取得 (外部・エージェント作成分も候補にする)
  useEffect(() => {
    let cancelled = false;
    api.listNotes().then(
      (res) => {
        if (!cancelled) {
          setNotes(res.notes);
          setNotesError(null);
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setNotesError(
            `ノート一覧を取得できませんでした — ${err instanceof ApiError ? err.message : String(err)}`,
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback((q: string): void => {
    const seq = (searchSeqRef.current += 1);
    api.search(q).then(
      (res) => {
        if (seq !== searchSeqRef.current) return; // 古い応答は捨てる
        setFulltext(res.results.filter((r): r is FulltextHit => r.line !== null));
        setSearchedQuery(q);
        setSearchError(null);
      },
      (err: unknown) => {
        if (seq !== searchSeqRef.current) return;
        setFulltext([]);
        setSearchedQuery(q);
        setSearchError(
          `全文検索に失敗しました — ${err instanceof ApiError ? err.message : String(err)}`,
        );
      },
    );
  }, []);

  /** デバウンス付きで全文検索を予約する。IME 変換中は呼ばない (decisions I3)。 */
  const scheduleSearch = useCallback(
    (raw: string): void => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      const q = raw.trim().normalize('NFC');
      if (q.length === 0) {
        searchSeqRef.current += 1; // 入力途中の応答も無効化
        setFulltext([]);
        setSearchedQuery('');
        setSearchError(null);
        return;
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        runSearch(q);
      }, SEARCH_DEBOUNCE_MS);
    },
    [runSearch],
  );

  useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    },
    [],
  );

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>): void => {
      const value = e.currentTarget.value;
      setQuery(value);
      setSelected(0);
      // ノート名フィルタ (ローカル) は変換中も追従する。全文検索は確定後のみ。
      if (!composingRef.current) scheduleSearch(value);
    },
    [scheduleSearch],
  );

  const onCompositionStart = useCallback((): void => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (e: CompositionEvent<HTMLInputElement>): void => {
      composingRef.current = false;
      scheduleSearch(e.currentTarget.value);
    },
    [scheduleSearch],
  );

  // 組み込みコマンドをレジストリへ登録 (handlers が提供された場合のみ)
  useEffect(() => {
    if (commandHandlers === undefined) return;
    registerBuiltinCommands(commandHandlers);
    setCommands(getCommands());
  }, [commandHandlers]);

  const noteMatches = useMemo(() => matchNotes(notes, query), [notes, query]);

  /** コマンドをクエリ (title / keywords) でフィルタリングする。空クエリは全件。 */
  const commandMatches = useMemo((): CommandEntry[] => {
    const q = normalize(query.trim());
    if (q.length === 0) return commands;
    return commands.filter(
      (c) =>
        normalize(c.title).includes(q) ||
        c.keywords.some((kw) => normalize(kw).includes(q)),
    );
  }, [commands, query]);

  const items = useMemo<PaletteItem[]>(
    () => [
      ...noteMatches.map((n): PaletteItem => ({ kind: 'note', path: n.path, title: n.title })),
      ...fulltext.map((hit): PaletteItem => ({ kind: 'fulltext', hit })),
      ...commandMatches.map((entry): PaletteItem => ({ kind: 'command', entry })),
    ],
    [noteMatches, fulltext, commandMatches],
  );

  // 候補の増減で選択が範囲外になったら先頭へ戻す
  const selectedIndex = items.length === 0 ? -1 : Math.min(selected, items.length - 1);

  // 選択候補を可視域に保つ
  useEffect(() => {
    resultsRef.current
      ?.querySelector('.palette-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, items]);

  const confirm = useCallback(
    (item: PaletteItem): void => {
      onClose();
      if (item.kind === 'note') {
        onOpenNote(item.path);
      } else if (item.kind === 'fulltext') {
        onOpenNoteAtLine(item.hit.path, item.hit.line);
      } else {
        // kind === 'command': パレットを閉じてからコマンドを実行する
        item.entry.run();
      }
    },
    [onClose, onOpenNote, onOpenNoteAtLine],
  );

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>): void => {
      // IME 変換中の Enter / Esc は変換の確定・取消であり、パレット操作ではない
      if (e.nativeEvent.isComposing || composingRef.current) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (items.length > 0) setSelected((selectedIndex + 1) % items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length > 0) setSelected((selectedIndex - 1 + items.length) % items.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = selectedIndex >= 0 ? items[selectedIndex] : undefined;
        if (item !== undefined) confirm(item);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [confirm, items, onClose, selectedIndex],
  );

  // パレット表示中の Cmd/Ctrl+K 再押下は入力を全選択して再フォーカス (decisions I5)。
  // Esc はフォーカスが input の外 (候補ボタン等) にあっても閉じる。
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === 'Escape' && !e.isComposing) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const onBackdropMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>): void => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const trimmed = query.trim();
  const error = searchError ?? notesError;
  const showEmpty =
    trimmed.length > 0 &&
    items.length === 0 &&
    error === null &&
    searchedQuery === trimmed.normalize('NFC');

  return (
    <div
      className="palette-backdrop"
      data-testid="command-palette-backdrop"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        className="palette"
        data-testid="command-palette"
        role="dialog"
        aria-label="コマンドパレット"
      >
        <div className="palette-input-row">
          <SearchIcon className="search-ico" />
          <input
            ref={inputRef}
            className="palette-input"
            data-testid="search-input"
            type="text"
            value={query}
            placeholder="検索またはコマンドを入力…"
            autoFocus
            onChange={onInputChange}
            onKeyDown={onInputKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="palette-results" ref={resultsRef}>
          {noteMatches.length > 0 && (
            <div className="palette-section-label" data-testid="palette-section-notes">
              <span>ノート</span>
              <span>{noteMatches.length} 件</span>
            </div>
          )}
          {noteMatches.map((n, i) => (
            <button
              key={`note:${n.path}`}
              className={`palette-item${selectedIndex === i ? ' selected' : ''}`}
              data-testid="search-result-note"
              data-path={n.path}
              aria-selected={selectedIndex === i ? 'true' : undefined}
              onClick={() => confirm({ kind: 'note', path: n.path, title: n.title })}
              onMouseMove={() => setSelected(i)}
            >
              <FileIcon className="file-ico" />
              <span className="p-main">
                <span className="p-title">{highlight(n.title, trimmed)}</span>
                <span className="p-path">{n.path}</span>
              </span>
            </button>
          ))}

          {fulltext.length > 0 && (
            <div className="palette-section-label" data-testid="palette-section-fulltext">
              <span>全文</span>
              <span>{fulltext.length} 件</span>
            </div>
          )}
          {fulltext.map((hit, fi) => {
            const i = noteMatches.length + fi;
            return (
              <button
                key={`ft:${hit.path}:${String(hit.line)}`}
                className={`palette-item${selectedIndex === i ? ' selected' : ''}`}
                data-testid="search-result-fulltext"
                data-path={hit.path}
                data-line={hit.line}
                aria-selected={selectedIndex === i ? 'true' : undefined}
                onClick={() => confirm({ kind: 'fulltext', hit })}
                onMouseMove={() => setSelected(i)}
              >
                <FileIcon className="file-ico" />
                <span className="p-main">
                  <span className="p-title">{hit.title}</span>
                  <span className="p-snippet">{highlight(hit.snippet, trimmed)}</span>
                </span>
                <span className="line-no">L{hit.line}</span>
              </button>
            );
          })}

          {/* ---- コマンドセクション (Sde7a63-1) ---- */}
          {commandMatches.length > 0 && (
            <div className="palette-section-label" data-testid="palette-section-commands">
              <span>コマンド</span>
              <span>{commandMatches.length} 件</span>
            </div>
          )}
          {commandMatches.map((entry, ci) => {
            const i = noteMatches.length + fulltext.length + ci;
            return (
              <button
                key={`cmd:${entry.id}`}
                className={`palette-item${selectedIndex === i ? ' selected' : ''}`}
                data-testid="command-item"
                data-command-id={entry.id}
                data-source={entry.source}
                aria-selected={selectedIndex === i ? 'true' : undefined}
                onClick={() => confirm({ kind: 'command', entry })}
                onMouseMove={() => setSelected(i)}
              >
                <span className="cmd-ico">{entry.icon}</span>
                <span className="p-main">
                  <span className="p-title">{highlight(entry.title, trimmed)}</span>
                </span>
                <span className={`cmd-source-badge${entry.source === 'builtin' ? ' builtin' : ''}`}>
                  {entry.source === 'builtin' ? '組み込み' : 'スマート'}
                </span>
              </button>
            );
          })}

          {error !== null && (
            <div className="palette-error" data-testid="search-error">
              {error}
            </div>
          )}
          {showEmpty && commandMatches.length === 0 && (
            <div className="palette-empty" data-testid="search-empty">
              「{trimmed}」に一致するノートはありません
            </div>
          )}
        </div>

        <div className="palette-footer">
          <button
            type="button"
            className="palette-advanced"
            data-testid="search-open-advanced"
            onClick={() => onOpenAdvanced(query)}
            title="条件を変えながら一覧を保って探せる詳細検索ページを開く"
          >
            <SearchIcon />
            詳細検索を開く
          </button>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 移動
          </span>
          <span>
            <kbd>Enter</kbd> 実行
          </span>
          <span>
            <kbd>Esc</kbd> 閉じる
          </span>
        </div>
      </div>
    </div>
  );
}
