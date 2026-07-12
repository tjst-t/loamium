/**
 * グローバル検索 + コマンドパレット (Sbd061c-1 / Sde7a63-1 / Sde7a63-2 / Sde7a63-3 / prototype/)。
 *
 * - ノート名セクション: 表示時に GET /api/notes を再取得し、クライアント側で
 *   NFC 正規化 + 大文字小文字不区別の部分一致 (タイトル / パス) フィルタ (decisions I1)。
 *   エージェントが外部で作ったノートも開くたびに対象になる。
 * - 全文セクション: 200ms デバウンスで GET /api/search。line が null の結果
 *   (タイトルのみ一致) はノート名セクションと重複するため出さない (decisions I2)。
 * - コマンドセクション (Sde7a63-1): getCommands() からクエリで絞り込み。
 *   空クエリでも全コマンドを表示する (edge: empty query shows commands)。
 * - スマートコマンド (Sde7a63-3): GET /api/commands を取得して source='smart' として登録。
 *   valid:false は data-disabled='true' で非選択可能。
 * - コマンド専用モード (Sde7a63-2): 先頭 '>' でコマンドのみに絞り込む。
 *   プレフィックス解析は palettePrefix.ts の parsePaletteInput() に集約 (ADR-0007)。
 * - IME: compositionstart〜compositionend 間は全文検索を確定しない (decisions I3)。
 * - Esc / 外側クリックで閉じる。↑↓ で選択、Enter / クリックで開く。
 */
import {
  Fragment,
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
import type { NoteMeta, SearchResult, CommandParam } from '@loamium/shared';
import { api, ApiError } from '../api.js';
import { FileIcon, SearchIcon } from '../icons.js';
import { getCommands, registerCommand, type CommandEntry } from '../commandRegistry.js';
import { registerBuiltinCommands } from '../builtinCommands.js';
import type { BuiltinCommandHandlers } from '../builtinCommands.js';
import { parsePaletteInput } from '../palettePrefix.js';
import { ParamFormModal } from './ParamFormModal.js';

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

/** スマートコマンドのパラメータフォームを開くときに渡す情報 */
interface ParamFormState {
  /** 表示名 (パレットタイトル表示用) */
  commandName: string;
  /** 安定識別子 = ファイル stem。POST /api/commands/{commandId}/run に使う */
  commandId: string;
  description?: string | undefined;
  params: CommandParam[];
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
  /** Sde7a63-3: パラメータフォームモーダルの状態 (null=非表示) */
  const [paramForm, setParamForm] = useState<ParamFormState | null>(null);

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

  /**
   * Sde7a63-3: GET /api/commands でスマートコマンドを取得してレジストリへ登録する。
   * 組み込みコマンドは builtinCommands.tsx が登録済みのため、再登録しない。
   * valid:false のエントリは disabled=true で登録する (非選択可能)。
   */
  const openNoteRef = useRef(onOpenNote);
  openNoteRef.current = onOpenNote;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const setParamFormRef = useRef(setParamForm);
  setParamFormRef.current = setParamForm;

  useEffect(() => {
    let cancelled = false;
    api.listCommands().then(
      (summaries) => {
        if (cancelled) return;
        for (const s of summaries) {
          if (!s.valid) {
            // valid:false → disabled エントリ
            registerCommand({
              id: `smart:${s.id}`,
              title: s.name,
              keywords: [],
              icon: (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="10" height="10" rx="2" />
                  <path d="M6 8l2 2 3-3" />
                </svg>
              ),
              source: 'smart',
              disabled: true,
              errorReason: s.error,
              run: () => { /* disabled — run は呼ばれない */ },
            });
          } else {
            // valid:true
            // cmdId = ファイル stem (安定識別子) → POST /api/commands/{cmdId}/run に使う
            // cmdName = 表示名 → パレットタイトル / フォームタイトルに使う
            const cmdId = s.id;
            const cmdName = s.name;
            const cmdParams = s.params;
            const cmdDesc = s.description;
            registerCommand({
              id: `smart:${cmdId}`,
              title: cmdName,
              keywords: [cmdId, cmdName],
              icon: (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="10" height="10" rx="2" />
                  <path d="M6 8l2 2 3-3" />
                </svg>
              ),
              source: 'smart',
              run: () => {
                if (cmdParams.length === 0) {
                  // パラメータなし → 直接実行 (cmdId = stem を渡す)
                  void api.runCommand(cmdId, {}).then(
                    (result) => {
                      const openPath = result.openPath;
                      onCloseRef.current();
                      if (openPath !== undefined) openNoteRef.current(openPath);
                    },
                    (err: unknown) => {
                      console.error('[loamium] smart command run failed:', err);
                      onCloseRef.current();
                    },
                  );
                } else {
                  // パラメータあり → フォームモーダルを開く (パレットは閉じない)
                  setParamFormRef.current({
                    commandName: cmdName,
                    commandId: cmdId,
                    description: cmdDesc,
                    params: cmdParams,
                  });
                }
              },
            });
          }
        }
        // レジストリから最新の全コマンドを反映
        setCommands(getCommands());
      },
      (err: unknown) => {
        // GET /api/commands 失敗はコンソールのみ (組み込みコマンドは引き続き表示)
        console.error('[loamium] failed to load smart commands:', err);
      },
    );
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // コマンド専用モード中は全文検索を行わない。
      const { mode } = parsePaletteInput(value);
      if (!composingRef.current && mode === 'normal') scheduleSearch(value);
      // コマンド専用モードへ切り替わった場合は進行中の全文検索を無効化してクリアする
      if (mode === 'command') {
        if (debounceRef.current !== null) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        searchSeqRef.current += 1;
        setFulltext([]);
        setSearchedQuery('');
        setSearchError(null);
      }
    },
    [scheduleSearch],
  );

  const onCompositionStart = useCallback((): void => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (e: CompositionEvent<HTMLInputElement>): void => {
      composingRef.current = false;
      // コマンド専用モード中は全文検索を行わない (コマンドのみ絞り込む)
      const { mode } = parsePaletteInput(e.currentTarget.value);
      if (mode === 'normal') scheduleSearch(e.currentTarget.value);
    },
    [scheduleSearch],
  );

  // 組み込みコマンドをレジストリへ登録 (handlers が提供された場合のみ)
  // NOTE: registerBuiltinCommands は upsert (id キーで上書き) で登録するため、
  // スマートコマンドと共存できる。clearRegistry() は呼ばれないので登録順序の制約はない。
  // Sde7a63-3: 登録後に setCommands を呼び、builtin + smart 両エントリを含む
  // 最新のレジストリ全体を UI に反映する。
  useEffect(() => {
    if (commandHandlers === undefined) return;
    registerBuiltinCommands(commandHandlers);
    setCommands(getCommands());
  }, [commandHandlers]);

  /** Sde7a63-2: parsePaletteInput で mode / commandQuery を派生する (ADR-0007: 単一正源) */
  const { mode: paletteMode, query: commandQuery } = useMemo(
    () => parsePaletteInput(query),
    [query],
  );

  /** 通常モードのみノート名マッチを計算する。コマンドモードでは空配列。 */
  const noteMatches = useMemo(
    () => (paletteMode === 'normal' ? matchNotes(notes, query) : []),
    [notes, query, paletteMode],
  );

  /** コマンドをクエリ (title / keywords) でフィルタリングする。空クエリは全件。
   * コマンドモード: commandQuery (プレフィックス除去後) で絞り込む。
   * 通常モード: query (raw) で絞り込む。
   */
  const commandMatches = useMemo((): CommandEntry[] => {
    const rawQ = paletteMode === 'command' ? commandQuery : query;
    const q = normalize(rawQ.trim());
    if (q.length === 0) return commands;
    return commands.filter(
      (c) =>
        normalize(c.title).includes(q) ||
        c.keywords.some((kw) => normalize(kw).includes(q)),
    );
  }, [commands, query, commandQuery, paletteMode]);

  /** コマンドモード中はノート/全文候補をフラットリストから除外する */
  const items = useMemo<PaletteItem[]>(() => {
    if (paletteMode === 'command') {
      return commandMatches.map((entry): PaletteItem => ({ kind: 'command', entry }));
    }
    return [
      ...noteMatches.map((n): PaletteItem => ({ kind: 'note', path: n.path, title: n.title })),
      ...fulltext.map((hit): PaletteItem => ({ kind: 'fulltext', hit })),
      ...commandMatches.map((entry): PaletteItem => ({ kind: 'command', entry })),
    ];
  }, [paletteMode, noteMatches, fulltext, commandMatches]);

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
      if (item.kind === 'note') {
        onClose();
        onOpenNote(item.path);
      } else if (item.kind === 'fulltext') {
        onClose();
        onOpenNoteAtLine(item.hit.path, item.hit.line);
      } else {
        // kind === 'command'
        if (item.entry.disabled === true) return; // valid:false — 選択不可
        // run() が自分でパレットを閉じる責任を持つ:
        //   - 組み込みコマンド: handlers.onXxx() → setPaletteOpen(false) (App.tsx)
        //   - スマートコマンド(params なし): run() → onCloseRef.current()
        //   - スマートコマンド(params あり): run() → setParamForm (パレットは閉じない)
        item.entry.run();
      }
    },
    [onClose, onOpenNote, onOpenNoteAtLine],
  );

  /** disabled コマンドをスキップする次のインデックスを求める */
  const nextSelectableIndex = useCallback(
    (start: number, direction: 1 | -1): number => {
      if (items.length === 0) return -1;
      let idx = (start + direction + items.length) % items.length;
      // 最大 items.length 回試みる (全件 disabled の場合を防ぐ)
      for (let i = 0; i < items.length; i++) {
        const item = items[idx];
        if (item === undefined) break;
        if (item.kind !== 'command' || item.entry.disabled !== true) return idx;
        idx = (idx + direction + items.length) % items.length;
      }
      return start; // すべて disabled なら元のまま
    },
    [items],
  );

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>): void => {
      // IME 変換中の Enter / Esc は変換の確定・取消であり、パレット操作ではない
      if (e.nativeEvent.isComposing || composingRef.current) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (items.length > 0) setSelected(nextSelectableIndex(selectedIndex, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length > 0) setSelected(nextSelectableIndex(selectedIndex, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = selectedIndex >= 0 ? items[selectedIndex] : undefined;
        if (item !== undefined) confirm(item);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // パラメータフォームが開いている場合は Esc をモーダルに委ねてパレットは閉じない
        if (paramFormRef.current !== null) return;
        onClose();
      }
    },
    [confirm, items, nextSelectableIndex, onClose, selectedIndex],
  );

  // パレット表示中の Cmd/Ctrl+K 再押下は入力を全選択して再フォーカス (decisions I5)。
  // Esc はフォーカスが input の外 (候補ボタン等) にあっても閉じる。
  // ただしパラメータフォームモーダルが開いている場合は Esc をモーダルに委ねる (パレットは閉じない)。
  const paramFormRef = useRef<ParamFormState | null>(null);
  paramFormRef.current = paramForm;
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === 'Escape' && !e.isComposing) {
        // パラメータフォームが開いている場合は Esc をモーダル側に委ねる
        if (paramFormRef.current !== null) return;
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
  /** highlight / empty 判定に使うクエリ。コマンドモードは '>' 除去後のクエリで強調する。 */
  const highlightQuery = paletteMode === 'command' ? commandQuery.trim() : trimmed;
  const error = searchError ?? notesError;
  const showEmpty =
    trimmed.length > 0 &&
    items.length === 0 &&
    error === null &&
    (paletteMode === 'command' || searchedQuery === trimmed.normalize('NFC'));

  return (
    <Fragment>
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
            placeholder={paletteMode === 'command' ? 'コマンドを入力…' : '検索またはコマンドを入力…'}
            autoFocus
            onChange={onInputChange}
            onKeyDown={onInputKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
          />
          {paletteMode === 'command' && (
            <span className="palette-mode-badge" data-testid="palette-mode-command">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 8l3-3-3-3M8 10h5" />
              </svg>
              コマンドモード
            </span>
          )}
          <kbd>Esc</kbd>
        </div>

        <div className="palette-results" ref={resultsRef}>
          {/* ノートセクション — コマンド専用モード中は非表示 (AC-Sde7a63-2-1) */}
          {paletteMode !== 'command' && noteMatches.length > 0 && (
            <div className="palette-section-label" data-testid="palette-section-notes">
              <span>ノート</span>
              <span>{noteMatches.length} 件</span>
            </div>
          )}
          {paletteMode !== 'command' && noteMatches.map((n, i) => (
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
                <span className="p-title">{highlight(n.title, highlightQuery)}</span>
                <span className="p-path">{n.path}</span>
              </span>
            </button>
          ))}

          {/* 全文セクション — コマンド専用モード中は非表示 (AC-Sde7a63-2-1) */}
          {paletteMode !== 'command' && fulltext.length > 0 && (
            <div className="palette-section-label" data-testid="palette-section-fulltext">
              <span>全文</span>
              <span>{fulltext.length} 件</span>
            </div>
          )}
          {paletteMode !== 'command' && fulltext.map((hit, fi) => {
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
                  <span className="p-snippet">{highlight(hit.snippet, highlightQuery)}</span>
                </span>
                <span className="line-no">L{hit.line}</span>
              </button>
            );
          })}

          {/* ---- コマンドセクション (Sde7a63-1 / Sde7a63-2 / Sde7a63-3) ---- */}
          {commandMatches.length > 0 && (
            <div className="palette-section-label" data-testid="palette-section-commands">
              <span>コマンド</span>
              <span>{commandMatches.length} 件</span>
            </div>
          )}
          {commandMatches.map((entry, ci) => {
            // コマンドモード: flat list は commands のみ → ci が直接 selectedIndex
            // 通常モード: ノート + 全文 + コマンドのフラットリスト
            const i = paletteMode === 'command'
              ? ci
              : noteMatches.length + fulltext.length + ci;
            const isDisabled = entry.disabled === true;
            return (
              <button
                key={`cmd:${entry.id}`}
                className={`palette-item${selectedIndex === i && !isDisabled ? ' selected' : ''}${isDisabled ? ' cmd-disabled' : ''}`}
                data-testid="command-item"
                data-command-id={entry.id}
                data-source={entry.source}
                data-disabled={isDisabled ? 'true' : undefined}
                aria-selected={selectedIndex === i && !isDisabled ? 'true' : undefined}
                aria-disabled={isDisabled ? 'true' : undefined}
                onClick={() => {
                  if (!isDisabled) confirm({ kind: 'command', entry });
                }}
                onMouseMove={() => {
                  if (!isDisabled) setSelected(i);
                }}
              >
                <span className="cmd-ico">{entry.icon}</span>
                <span className="p-main">
                  <span className="p-title">{highlight(entry.title, highlightQuery)}</span>
                  {isDisabled && entry.errorReason !== undefined && (
                    <span className="cmd-error-reason" data-testid="command-item-error-reason">
                      {entry.errorReason}
                    </span>
                  )}
                </span>
                <span className={`cmd-source-badge${entry.source === 'builtin' ? ' builtin' : isDisabled ? ' disabled' : ''}`}>
                  {entry.source === 'builtin' ? '組み込み' : isDisabled ? '無効' : 'スマート'}
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
              {paletteMode === 'command'
                ? `「${highlightQuery}」に一致するコマンドはありません`
                : `「${trimmed}」に一致するノートはありません`}
            </div>
          )}
        </div>

        <div className="palette-footer">
          {paletteMode === 'command' ? (
            <span>
              <kbd>{'>'}</kbd> を削除で通常モードへ戻る
            </span>
          ) : (
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
          )}
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

    {/* Sde7a63-3: パラメータフォームモーダル (パレットの上にオーバーレイ) */}
    {paramForm !== null && (
      <ParamFormModal
        commandName={paramForm.commandName}
        commandId={paramForm.commandId}
        description={paramForm.description}
        params={paramForm.params}
        onCancel={() => {
          // Esc / キャンセル → フォームを閉じてパレットへ戻る (パレットは閉じない)
          setParamForm(null);
          // パレットの検索入力へ再フォーカス
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        onSuccess={(openPath) => {
          // 成功 → パレット + フォームを閉じる
          setParamForm(null);
          onClose();
          if (openPath !== undefined) {
            onOpenNote(openPath);
          }
        }}
      />
    )}
    </Fragment>
  );
}
