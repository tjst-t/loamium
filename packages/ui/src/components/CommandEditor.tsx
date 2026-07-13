/**
 * CommandEditor — スマートコマンド定義の専用スプリットエディタ (ADR-0024)。
 *
 * レイアウト: 左ペイン (素の YAML CodeMirror) + 右ペイン (ライブ検証 + プレビュー + テスト実行)。
 *
 * ADR-0024: commands/*.yaml ファイル全体が LoamiumCommand YAML。
 *           Markdown/WikiLink/スラッシュメニュー拡張は一切含まない。
 *           DSL 補完のみ (commandDslCompletionExtension)。
 *
 * AC-S9e64e7-1-1: commands/*.yaml → CommandEditor を描画 (App.tsx 側で分岐)。
 * AC-S9e64e7-1-2: 保存ボタンは INVALID のとき aria-disabled。保存は PUT /api/notes/{path}。
 * AC-S9e64e7-1-3: testid は gui-spec / prototype V3 に準拠。
 *
 * AC-S9e64e7-2-1: YAML をリアルタイム検証 (parseLoamiumCommandFileWithError)。
 *                 cmd-edit-validation[data-valid=true|false] で表示。invalid は save/test-run も無効。
 * AC-S9e64e7-2-2: 右ペインに params/steps プレビュー。
 *                 cmd-param-row[data-name][data-type][data-required]、
 *                 cmd-step-row[data-index][data-kind]。
 * AC-S9e64e7-2-3: cmd-edit-test-run でコマンド実行。
 *                 未保存(dirty)なら先に PUT 保存してから POST run。
 *                 params があれば TestRunParamForm (param-form-modal testid) を開き
 *                 params 収集後に CommandEditor 自身が api.runCommand を呼ぶ。
 *                 id は path の stem (commands/create-todo.yaml → create-todo)。
 *                 結果は cmd-edit-run-result に step-result[data-kind][data-ok] で表示。
 *
 * prototype/command-editor.html V3 の split + validate バナー レイアウトを移植。
 * CSS は styles.css に追加済み (.cmd-editor-split など)。
 * Known past failure: inline SVG を `:where(svg)` ガード無しで使うと巨大化する。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  parseLoamiumCommandFileWithError,
  type LoamiumCommand,
  type CommandParam,
  type CommandRunResponse,
} from '@loamium/shared';
import { api } from '../api.js';
import { commandDslCompletionExtension } from '../commandDslCompletion.js';

/** 検証結果 */
type ValidationResult =
  | { valid: true; command: LoamiumCommand }
  | { valid: false; error: string };

/**
 * バッファ全体 (純粋 YAML) を parseLoamiumCommandFileWithError で検証する (ADR-0024)。
 * frontmatter 抽出は不要 — ファイル全体が LoamiumCommand YAML。
 */
function validateText(text: string): ValidationResult {
  const result = parseLoamiumCommandFileWithError(text);
  if (result.ok) return { valid: true, command: result.command };
  return { valid: false, error: result.error };
}

/** path (e.g. "commands/create-todo.yaml") からコマンド ID (stem) を取り出す (ADR-0024)。 */
function extractCommandId(docPath: string): string {
  return docPath.split('/').at(-1)?.replace(/\.ya?ml$/i, '') ?? docPath;
}

/** ステップのキーフィールド (target / section / content / template など) の概要を返す。 */
function stepSummary(step: LoamiumCommand['steps'][number]): string {
  const parts: string[] = [];
  if ('target' in step && step.target !== undefined) parts.push(`target: ${step.target}`);
  if ('section' in step && step.section !== undefined) parts.push(`section: ${step.section}`);
  if ('content' in step && step.content !== undefined) {
    const snippet = step.content.length > 30 ? `${step.content.slice(0, 30)}…` : step.content;
    parts.push(`content: ${snippet}`);
  }
  if ('template' in step && step.template !== undefined) parts.push(`template: ${step.template}`);
  if ('old' in step && step.old !== undefined) parts.push(`old: ${step.old.slice(0, 20)}`);
  if ('set' in step && step.set !== undefined) {
    const keys = Object.keys(step.set).join(', ');
    parts.push(`set: {${keys}}`);
  }
  return parts.join(', ');
}

// ---- テスト実行ステートマシン ----

type RunState =
  | { phase: 'idle' }
  | { phase: 'param-form' }
  | { phase: 'running' }
  | { phase: 'done'; result: CommandRunResponse }
  | { phase: 'error'; message: string };

// ============================================================
// TestRunParamForm — CommandEditor 専用 param 収集モーダル
// (ParamFormModal の param-form-modal / param-field testid を再現し、
//  submit 後は親が api.runCommand を呼ぶ。)
// ============================================================

interface TestRunParamFormProps {
  commandName: string;
  description: string | undefined;
  params: CommandParam[];
  /** フォーム送信: values を返す */
  onSubmit: (values: Record<string, string>) => void;
  /** キャンセル */
  onCancel: () => void;
}

function todayDateStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function TestRunParamForm({
  commandName,
  description,
  params,
  onSubmit,
  onCancel,
}: TestRunParamFormProps): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of params) {
      init[p.name] = p.default !== undefined ? p.default : p.type === 'date' ? todayDateStr() : '';
    }
    return init;
  });
  const [showErrors, setShowErrors] = useState(false);
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const requiredMissing = useMemo(
    () =>
      params
        .filter((p) => p.required === true && (values[p.name] ?? '').trim() === '')
        .map((p) => p.name),
    [params, values],
  );
  const canSubmit = requiredMissing.length === 0;

  const setValue = useCallback((name: string, value: string): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleSubmit = useCallback((): void => {
    if (requiredMissing.length > 0) {
      setShowErrors(true);
      return;
    }
    onSubmit(values);
  }, [requiredMissing.length, onSubmit, values]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        const el = e.target as HTMLElement;
        if (el.tagName.toLowerCase() === 'textarea') return;
        e.preventDefault();
        handleSubmit();
      }
    },
    [onCancel, handleSubmit],
  );

  return (
    <div
      className="param-form-backdrop"
      data-testid="param-form-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className="param-modal"
        data-testid="param-form-modal"
        role="dialog"
        aria-label={`${commandName} — パラメータ入力`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ヘッダ */}
        <div className="param-modal-head">
          <span className="param-h-ico">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="2"/>
              <path d="M6 8l2 2 3-3"/>
            </svg>
          </span>
          <div className="param-h-main">
            <h2 data-testid="param-form-title">{commandName}</h2>
            {description !== undefined ? <div className="sub">{description}</div> : null}
          </div>
          <button
            className="icon-btn"
            data-testid="param-form-close"
            title="キャンセル (Esc)"
            onClick={onCancel}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>

        {/* パラメータフィールド */}
        <div className="param-fields">
          {params.map((p, i) => {
            const invalid = showErrors && requiredMissing.includes(p.name);
            const label = p.label ?? p.name;
            const fieldType = p.type ?? 'string';
            return (
              <div
                key={p.name}
                className={`param-field-row${invalid ? ' invalid' : ''}`}
                data-testid="param-field"
                data-name={p.name}
                data-type={fieldType}
                data-required={p.required === true ? 'true' : 'false'}
              >
                <label className="param-field-label">
                  {label}
                  {p.required === true ? (
                    <span className="req">*</span>
                  ) : (
                    <span className="opt">任意</span>
                  )}
                </label>
                <div className="param-field-body">
                  {fieldType === 'text' ? (
                    <textarea
                      className={`param-input${invalid ? ' invalid' : ''}`}
                      data-testid="param-field-input"
                      data-name={p.name}
                      rows={3}
                      value={values[p.name] ?? ''}
                      placeholder={label}
                      autoComplete="off"
                      aria-invalid={invalid ? 'true' : undefined}
                      onChange={(e) => setValue(p.name, e.target.value)}
                      ref={(el) => {
                        if (i === 0) firstInputRef.current = el;
                      }}
                    />
                  ) : fieldType === 'date' ? (
                    <input
                      className={`param-input${invalid ? ' invalid' : ''}`}
                      data-testid="param-field-input"
                      data-name={p.name}
                      type="date"
                      value={values[p.name] ?? ''}
                      autoComplete="off"
                      aria-invalid={invalid ? 'true' : undefined}
                      onChange={(e) => setValue(p.name, e.target.value)}
                      ref={(el) => {
                        if (i === 0) firstInputRef.current = el;
                      }}
                    />
                  ) : fieldType === 'select' && p.options !== undefined ? (
                    <select
                      className={`param-input${invalid ? ' invalid' : ''}`}
                      data-testid="param-field-input"
                      data-name={p.name}
                      value={values[p.name] ?? ''}
                      aria-invalid={invalid ? 'true' : undefined}
                      onChange={(e) => setValue(p.name, e.target.value)}
                      ref={(el) => {
                        if (i === 0) firstInputRef.current = el;
                      }}
                    >
                      <option value="">選択してください</option>
                      {p.options.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : fieldType === 'boolean' ? (
                    <input
                      className={`param-input${invalid ? ' invalid' : ''}`}
                      data-testid="param-field-input"
                      data-name={p.name}
                      type="checkbox"
                      checked={(values[p.name] ?? '') === 'true'}
                      aria-invalid={invalid ? 'true' : undefined}
                      onChange={(e) => setValue(p.name, e.target.checked ? 'true' : '')}
                      ref={(el) => {
                        if (i === 0) firstInputRef.current = el;
                      }}
                    />
                  ) : fieldType === 'number' ? (
                    <input
                      className={`param-input${invalid ? ' invalid' : ''}`}
                      data-testid="param-field-input"
                      data-name={p.name}
                      type="number"
                      value={values[p.name] ?? ''}
                      placeholder={label}
                      autoComplete="off"
                      aria-invalid={invalid ? 'true' : undefined}
                      onChange={(e) => setValue(p.name, e.target.value)}
                      ref={(el) => {
                        if (i === 0) firstInputRef.current = el;
                      }}
                    />
                  ) : (
                    /* note / string (default) → input[type=text] */
                    <input
                      className={`param-input${invalid ? ' invalid' : ''}`}
                      data-testid="param-field-input"
                      data-name={p.name}
                      type="text"
                      value={values[p.name] ?? ''}
                      placeholder={label}
                      autoComplete="off"
                      aria-invalid={invalid ? 'true' : undefined}
                      onChange={(e) => setValue(p.name, e.target.value)}
                      ref={(el) => {
                        if (i === 0) firstInputRef.current = el;
                      }}
                    />
                  )}
                  {invalid && (
                    <div
                      className="param-field-error"
                      data-testid="param-field-error"
                      data-name={p.name}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                        <circle cx="8" cy="8" r="6"/>
                        <path d="M8 5v4M8 11h.01"/>
                      </svg>
                      {label}は必須です
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* フッタ */}
        <div className="param-modal-foot">
          <div className="param-kbd-hints">
            <span><kbd>Tab</kbd> 移動</span>
            <span><kbd>Enter</kbd> 実行</span>
            <span><kbd>Esc</kbd> 戻る</span>
          </div>
          <div className="param-foot-actions">
            <button className="btn" data-testid="param-form-cancel" onClick={onCancel}>
              キャンセル
            </button>
            <button
              className="btn primary"
              data-testid="param-form-submit"
              aria-disabled={!canSubmit ? 'true' : undefined}
              onClick={() => handleSubmit()}
            >
              実行
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CommandEditor 本体
// ============================================================

export interface CommandEditorProps {
  /** 開いているコマンド定義ファイルのパス (commands/*.yaml) */
  docPath: string;
  /** ファイルの初期テキスト (純粋 YAML — ADR-0024) */
  content: string;
  /** 同一パスのまま外部内容で置き換えたいとき増やす */
  resetToken: number;
  /** mtime (競合検出用) */
  mtime: number | null;
  /** テキスト変化のコールバック (App 側の contentRef / dirtyRef を更新) */
  onChange: (text: string) => void;
  /** 保存成功のコールバック (mtime 更新 + backlinksToken 更新等) */
  onSaved: (mtime: number) => void;
  /** 保存失敗のコールバック (error メッセージ) */
  onSaveError: (msg: string) => void;
}

export function CommandEditor({
  docPath,
  content,
  resetToken,
  mtime,
  onChange,
  onSaved,
  onSaveError,
}: CommandEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSavedRef = useRef(onSaved);
  const onSaveErrorRef = useRef(onSaveError);
  const suppressRef = useRef(false);
  onChangeRef.current = onChange;
  onSavedRef.current = onSaved;
  onSaveErrorRef.current = onSaveError;

  const mtimeRef = useRef(mtime);
  mtimeRef.current = mtime;

  // 現在のエディタテキスト (リアルタイム — CodeMirror の onChange から更新)
  const textRef = useRef(content);
  // バリデーション状態 (valid + parsed command or error) (AC-S9e64e7-2-1)
  const [validation, setValidation] = useState<ValidationResult>(() => validateText(content));
  // 保存中フラグ
  const savingRef = useRef(false);
  // dirty 状態 (保存ステータス表示用)
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);

  // テスト実行ステートマシン (AC-S9e64e7-2-3)
  const [runState, setRunState] = useState<RunState>({ phase: 'idle' });

  /**
   * 左ペイン CodeMirror 用 Extension リスト (ADR-0024)。
   * Markdown / WikiLink / スラッシュメニュー 拡張を含まない純粋 YAML エディタ。
   * DSL 補完 (commandDslCompletionExtension) のみ補完を提供する。
   */
  const buildExtensions = useCallback((): Extension[] => [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          void handleSave();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    // DSL v2 補完のみ (Markdown/WikiLink 拡張なし — ADR-0024 / user-reported bug fix)
    commandDslCompletionExtension(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !suppressRef.current) {
        const text = update.state.doc.toString();
        textRef.current = text;
        dirtyRef.current = true;
        setDirty(true);
        onChangeRef.current(text);
        // リアルタイムバリデーション (AC-S9e64e7-2-1)
        setValidation(validateText(text));
      }
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  // 初回マウント: CodeMirror インスタンス生成
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: buildExtensions(),
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // docPath / resetToken 変化時: ドキュメント差し替え
  const mountedDocRef = useRef<{ path: string; token: number } | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const prev = mountedDocRef.current;
    if (prev !== null && prev.path === docPath && prev.token === resetToken) return;
    mountedDocRef.current = { path: docPath, token: resetToken };
    if (prev === null) return; // 初期内容は EditorState.create で反映済み
    suppressRef.current = true;
    view.setState(
      EditorState.create({
        doc: content,
        extensions: buildExtensions(),
      }),
    );
    suppressRef.current = false;
    textRef.current = content;
    dirtyRef.current = false;
    setDirty(false);
    setValidation(validateText(content));
    // ファイルが変わったら実行状態をリセット
    setRunState({ phase: 'idle' });
    view.focus();
  }, [docPath, content, resetToken, buildExtensions]);

  // 保存ハンドラ (PUT /api/commands/{id}/source — notes API の .md 強制を回避)
  // Invalid のとき保存しない (UI ではボタンを aria-disabled にするが、防御的にも実装する)
  const handleSave = useCallback(async (): Promise<void> => {
    const v = validateText(textRef.current);
    if (!v.valid) return;
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const base = mtimeRef.current ?? undefined;
      // ADR-0024: stem を使って source エンドポイントへ PUT (notes API は .md 強制のため使わない)
      const commandId = extractCommandId(docPath);
      const res = await api.putCommandSource(commandId, textRef.current, base);
      dirtyRef.current = false;
      setDirty(false);
      onSavedRef.current(res.mtime);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onSaveErrorRef.current(msg);
    } finally {
      savingRef.current = false;
    }
  }, [docPath]);

  /**
   * コマンド実行 (params 収集済み)。
   * AC-S9e64e7-2-3: id = commands/ stem (NOT display name)。
   */
  const doRun = useCallback(async (collectedParams: Record<string, string>): Promise<void> => {
    const commandId = extractCommandId(docPath);
    setRunState({ phase: 'running' });
    try {
      const result = await api.runCommand(commandId, collectedParams);
      setRunState({ phase: 'done', result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunState({ phase: 'error', message: msg });
    }
  }, [docPath]);

  /**
   * テスト実行ボタンハンドラ (AC-S9e64e7-2-3)
   * 1. invalid → 何もしない (ボタンが aria-disabled)
   * 2. dirty (未保存) → 先に PUT 保存
   * 3. params あり → TestRunParamForm モーダルを開く
   * 4. params なし → 即 POST run
   */
  const handleTestRun = useCallback((): void => {
    const v = validateText(textRef.current);
    if (!v.valid) return;
    if (runState.phase === 'running') return;

    void (async (): Promise<void> => {
      // 未保存なら先に保存 (AC-S9e64e7-2-3)
      if (dirtyRef.current) {
        await handleSave();
      }

      const cmd = v.command;
      if (cmd.params.length > 0) {
        // params がある → モーダルを開く
        setRunState({ phase: 'param-form' });
      } else {
        // params なし → 即実行
        await doRun({});
      }
    })();
  }, [runState.phase, handleSave, doRun]);

  // ブレッドクラム (commands / {stem})
  const stem = extractCommandId(docPath);

  const isValid = validation.valid;
  const parsedCommand: LoamiumCommand | null = validation.valid ? validation.command : null;
  const params: CommandParam[] = parsedCommand?.params ?? [];
  const steps: LoamiumCommand['steps'] = parsedCommand?.steps ?? [];

  const isRunning = runState.phase === 'running';
  const isTestRunDisabled = !isValid || isRunning;

  // run result 表示用
  const runResultData: CommandRunResponse | null =
    runState.phase === 'done' ? runState.result : null;
  const runErrorMsg: string | null =
    runState.phase === 'error' ? runState.message : null;
  const showRunResult = runResultData !== null || runErrorMsg !== null;

  return (
    <div className="cmd-editor" data-testid="command-editor">
      {/* ヘッダ: ブレッドクラム + バッジ + 保存ステータス */}
      <div className="cmd-editor-header" data-testid="command-editor-header">
        <div className="cmd-editor-breadcrumb">
          <span>commands</span>
          <span className="cmd-editor-sep">/</span>
          <span className="cmd-editor-crumb-curr">{stem}</span>
        </div>

        {/* スマートコマンドバッジ */}
        <span className="cmd-mode-badge" data-testid="cmd-mode-badge">
          {/* SVG icon — `:where(svg)` ガードで 16×16 を基底に */}
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6"/>
            <path d="M8 5v3l2 2"/>
          </svg>
          スマートコマンド定義
        </span>

        {/* 保存ステータス */}
        <div
          className="save-status"
          data-testid="save-status"
          data-state={dirty ? 'dirty' : 'saved'}
        >
          <span className="dot" />
          <span>{dirty ? '未保存' : '保存済み'}</span>
        </div>
      </div>

      {/* スプリットレイアウト */}
      <div className="cmd-editor-split">
        {/* 左ペイン: 素の YAML CodeMirror (ADR-0024: Markdown 拡張なし、DSL 補完のみ) */}
        <div className="cmd-editor-left" data-testid="cmd-edit-yaml">
          <div className="cmd-editor-pane-bar">
            <span className="cmd-editor-pane-lang">YAML</span>
            <span className="cmd-editor-pane-label">{docPath} · ソース</span>
          </div>
          <div className="cmd-editor-cm-host" ref={hostRef} />
        </div>

        {/* 右ペイン: バリデーション + params/steps プレビュー + テスト実行 */}
        <div className="cmd-editor-right" data-testid="cmd-edit-preview">
          {/* バリデーション結果バー (AC-S9e64e7-2-1) */}
          <div
            className={`cmd-editor-validation${isValid ? ' valid' : ' invalid'}`}
            data-testid="cmd-edit-validation"
            data-valid={isValid ? 'true' : 'false'}
          >
            {isValid ? (
              <>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M3 8l3.5 3.5L13 4"/>
                </svg>
                <span>✓ 有効</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M8 4v4M8 11v1"/>
                  <circle cx="8" cy="8" r="6"/>
                </svg>
                <span>✗ エラー</span>
              </>
            )}
          </div>

          {/* エラー詳細バナー (invalid のときのみ表示) */}
          {!isValid && (
            <div className="cmd-editor-error-banner" data-testid="cmd-edit-error">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M8 4v4M8 11v1"/>
                <circle cx="8" cy="8" r="6"/>
              </svg>
              <span>{(validation as { valid: false; error: string }).error}</span>
            </div>
          )}

          {/* 右ペインの本体: params + steps プレビュー + 実行結果 */}
          <div className="cmd-editor-preview-body">
            {isValid && parsedCommand !== null && (
              <>
                {/* コマンド名 + 説明 */}
                {parsedCommand.name !== undefined && (
                  <div className="cmd-editor-cmd-name">⚡ {parsedCommand.name}</div>
                )}
                {parsedCommand.description !== undefined && (
                  <div className="cmd-editor-cmd-desc">{parsedCommand.description}</div>
                )}

                {/* パラメータ一覧 (AC-S9e64e7-2-2) */}
                {params.length > 0 && (
                  <div className="cmd-editor-section">
                    <div className="cmd-editor-section-title">パラメータ</div>
                    {params.map((p) => (
                      <div
                        key={p.name}
                        className="cmd-param-row"
                        data-testid="cmd-param-row"
                        data-name={p.name}
                        data-type={p.type ?? 'string'}
                        data-required={p.required === true ? 'true' : 'false'}
                      >
                        <span className="cmd-param-name">{p.name}</span>
                        <span className="cmd-param-type">{p.type ?? 'string'}</span>
                        {p.required === true && (
                          <span className="cmd-param-required">必須</span>
                        )}
                        {p.type === 'select' && p.options !== undefined && p.options.length > 0 && (
                          <span className="cmd-param-options">
                            [{p.options.join(' | ')}]
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* ステップ一覧 (AC-S9e64e7-2-2) */}
                {steps.length > 0 && (
                  <div className="cmd-editor-section">
                    <div className="cmd-editor-section-title">ステップ</div>
                    {steps.map((step, idx) => {
                      const hasWhen =
                        'when' in step && (step as { when?: string }).when !== undefined;
                      const hasWhenNot =
                        'when-not' in step &&
                        (step as { 'when-not'?: string })['when-not'] !== undefined;
                      const hasCondition = hasWhen || hasWhenNot;
                      const summary = stepSummary(step);
                      const whenVal = hasWhen
                        ? (step as { when?: string }).when
                        : hasWhenNot
                        ? (step as { 'when-not'?: string })['when-not']
                        : undefined;
                      return (
                        <div
                          key={idx}
                          className="cmd-step-row"
                          data-testid="cmd-step-row"
                          data-index={String(idx)}
                          data-kind={step.kind}
                          {...(hasCondition && whenVal !== undefined
                            ? { 'data-when': whenVal }
                            : {})}
                        >
                          <span className="step-kind">{step.kind}</span>
                          {summary.length > 0 && (
                            <span className="cmd-step-summary">{summary}</span>
                          )}
                          {hasCondition && (
                            <span className="cmd-step-when">
                              {hasWhen
                                ? `when: ${(step as { when?: string }).when ?? ''}`
                                : `when-not: ${(step as { 'when-not'?: string })['when-not'] ?? ''}`}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* テスト実行結果 (AC-S9e64e7-2-3) */}
            {showRunResult && (
              <div className="cmd-edit-run-result" data-testid="cmd-edit-run-result">
                {runResultData !== null && (
                  <>
                    <div
                      className={`cmd-run-result-head${
                        runResultData.results.some((r) => !r.ok) ? ' failure' : ' success'
                      }`}
                    >
                      {runResultData.results.every((r) => r.ok) ? (
                        <>
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                            <circle cx="8" cy="8" r="6"/>
                            <path d="M5.5 8l2 2 3-3"/>
                          </svg>
                          実行成功
                        </>
                      ) : (
                        <>
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                            <circle cx="8" cy="8" r="6"/>
                            <path d="M8 5v4M8 11h.01"/>
                          </svg>
                          実行失敗
                        </>
                      )}
                    </div>
                    {runResultData.results.map((stepResult, idx) => (
                      <div
                        key={`${stepResult.kind}-${idx}`}
                        className="step-result"
                        data-testid="step-result"
                        data-kind={stepResult.kind}
                        data-ok={stepResult.ok ? 'true' : 'false'}
                      >
                        {stepResult.ok ? (
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                            <circle cx="8" cy="8" r="6"/>
                            <path d="M5.5 8l2 2 3-3"/>
                          </svg>
                        ) : (
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                            <path d="M4 4l8 8M12 4l-8 8"/>
                          </svg>
                        )}
                        <span className="step-kind">{stepResult.kind}</span>
                        {stepResult.path !== undefined && <span>{stepResult.path}</span>}
                        {stepResult.error !== undefined && <span>{stepResult.error}</span>}
                      </div>
                    ))}
                  </>
                )}
                {runErrorMsg !== null && (
                  <div
                    className="step-result"
                    data-testid="step-result"
                    data-kind="request"
                    data-ok="false"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8"/>
                    </svg>
                    <span className="step-kind">request</span>
                    <span>{runErrorMsg}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* アクションバー: テスト実行ボタン + 保存ボタン */}
          <div className="cmd-editor-actions">
            {/* テスト実行ボタン (AC-S9e64e7-2-3) */}
            <button
              className="cmd-test-run-btn"
              data-testid="cmd-edit-test-run"
              aria-disabled={isTestRunDisabled ? 'true' : undefined}
              onClick={() => {
                if (isTestRunDisabled) return;
                handleTestRun();
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <polygon points="4,2 14,8 4,14" fill="currentColor" stroke="none"/>
              </svg>
              {isRunning ? '実行中…' : 'テスト実行'}
            </button>

            {/* 保存ボタン (AC-S9e64e7-1-2) */}
            {isValid ? (
              <button
                className="btn primary"
                data-testid="cmd-edit-save"
                onClick={() => void handleSave()}
              >
                保存
              </button>
            ) : (
              <button
                className="btn primary"
                data-testid="cmd-edit-save"
                aria-disabled="true"
                title="エラーを修正してください"
                onClick={(e) => e.preventDefault()}
              >
                保存
              </button>
            )}
          </div>
        </div>
      </div>

      {/* TestRunParamForm モーダル: params 収集 → CommandEditor が run を呼ぶ (AC-S9e64e7-2-3) */}
      {runState.phase === 'param-form' && parsedCommand !== null && (
        <TestRunParamForm
          commandName={parsedCommand.name ?? stem}
          description={parsedCommand.description}
          params={params}
          onSubmit={(values) => {
            void doRun(values);
          }}
          onCancel={() => setRunState({ phase: 'idle' })}
        />
      )}
    </div>
  );
}
