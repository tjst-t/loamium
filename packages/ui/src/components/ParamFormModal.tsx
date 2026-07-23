/**
 * スマートコマンド パラメータフォームモーダル (Sde7a63-3)。
 *
 * TemplateModal (S89a350-3) と同型の実装パターン。
 * - type='string' (または省略) → <input type="text"> (1 行)
 * - type='text'               → <textarea> (複数行)
 * - type='date'               → <input type="date">
 * - type='select'+optionsQuery → <select> 動的ドロップダウン (data-widget="dynamic-select")
 * - type='note'+optionsQuery  → ノートピッカー (data-widget="note-picker")
 * - required 検証 / インラインエラー / submit 無効化
 * - Enter で実行 / Esc でパレットへ戻る (パレットは閉じない)
 * - 実行後: 成功は呼び出し元が閉じる / 失敗は param-form-result を表示
 *
 * S1bd397-4: optionsQuery 対応
 *   testid_contract (追加分):
 *   param-field-input[data-name][data-widget="dynamic-select"|"autocomplete"|"note-picker"]
 *   param-field-options-loading[data-name], param-field-options-empty[data-name]
 *
 * testid_contract (Sde7a63-3):
 *   param-form-modal, param-form-modal-backdrop, param-form-title,
 *   param-field[data-name][data-type][data-required],
 *   param-field-input[data-name], param-field-error[data-name],
 *   param-form-submit, param-form-cancel (フッタのキャンセル/閉じるボタン),
 *   param-form-close (ヘッダ右端のアイコンボタン),
 *   param-form-result, step-result[data-kind][data-ok]
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
import { CloseIcon } from '../icons.js';
import { api } from '../api.js';
import type { CommandParam, CommandRunResponse } from '@loamium/shared';

export interface ParamFormModalProps {
  /** 表示名 (パレット / フォームタイトルに使う) */
  commandName: string;
  /**
   * 安定識別子 = ファイル stem (例: "create-todo")。
   * POST /api/commands/{commandId}/run の {commandId} として使う。
   * 省略時は commandName を代用する (後方互換)。
   */
  commandId?: string | undefined;
  /** コマンドの説明 (省略可) */
  description?: string | undefined;
  /** パラメータ定義一覧 */
  params: CommandParam[];
  /** フォームキャンセル / Esc → パレットへ戻る (パレットは閉じない) */
  onCancel: () => void;
  /**
   * 実行成功 (openPath あり) → 呼び出し元がノートへ遷移しモーダル+パレットを閉じる。
   * 実行成功 (openPath なし) → パレットのみ閉じる。
   */
  onSuccess: (openPath: string | undefined) => void;
  /**
   * runCommand が結果を返した後に呼ぶ (sidebar-refresh)。
   * 全成功・部分失敗の両方 (= 実行が1回でも走った) で呼ぶ。コマンドがファイルを書いた
   * 可能性があるため、左サイドバー (ファイルツリー) を再取得させる。ネットワーク例外時は呼ばない。
   */
  onRan?: (() => void) | undefined;
}

/** 今日の日付を YYYY-MM-DD 形式で返す */
function todayDateStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** パラメータの初期値 */
function initialValue(p: CommandParam): string {
  if (p.default !== undefined) return p.default;
  if (p.type === 'date') return todayDateStr();
  return '';
}

/** 候補フェッチ状態 */
type CandidateState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; candidates: { value: string; label: string }[]; truncated: boolean }
  | { status: 'error' };

/** optionsQuery 内の {{変数名}} を resolvedVars で差し込んで返す。 */
function interpolateQuery(dql: string, resolvedVars: Record<string, string>): string {
  return dql.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => resolvedVars[name] ?? '');
}

/** optionsQuery が参照する変数名一覧を返す。 */
function getQueryDeps(optionsQuery: string | undefined): string[] {
  if (optionsQuery === undefined) return [];
  const matches = optionsQuery.matchAll(/\{\{([^}]+)\}\}/g);
  return Array.from(matches, (m) => m[1] ?? '').filter((n) => n !== '');
}

export function ParamFormModal({
  commandName,
  commandId,
  description,
  params,
  onCancel,
  onSuccess,
  onRan,
}: ParamFormModalProps): JSX.Element {
  // 安定識別子: commandId が提供されていればそれを使い、なければ commandName を代用する
  const runId = commandId ?? commandName;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of params) init[p.name] = initialValue(p);
    return init;
  });
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runResult, setRunResult] = useState<CommandRunResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // 候補フェッチ状態 (S1bd397-4)
  const [candidateStates, setCandidateStates] = useState<Record<string, CandidateState>>(() => {
    const init: Record<string, CandidateState> = {};
    for (const p of params) init[p.name] = { status: 'idle' };
    return init;
  });

  const fetchCandidates = useCallback(
    async (paramName: string, dql: string, resolvedVars: Record<string, string>): Promise<void> => {
      setCandidateStates((prev) => ({ ...prev, [paramName]: { status: 'loading' } }));
      try {
        const interpolated = interpolateQuery(dql, resolvedVars);
        const resp = await api.queryOptions(interpolated);
        setCandidateStates((prev) => ({
          ...prev,
          [paramName]: { status: 'loaded', candidates: resp.candidates, truncated: resp.truncated },
        }));
        if (resp.candidates.length > 0) {
          setValues((prev) => {
            const cur = prev[paramName] ?? '';
            if (cur === '' || !resp.candidates.some((c) => c.value === cur)) {
              return { ...prev, [paramName]: resp.candidates[0]?.value ?? '' };
            }
            return prev;
          });
        }
      } catch {
        setCandidateStates((prev) => ({ ...prev, [paramName]: { status: 'error' } }));
      }
    },
    [],
  );

  // 初回マウント: 依存なし optionsQuery パラメータをフェッチ
  useEffect(() => {
    for (const p of params) {
      if (p.optionsQuery === undefined) continue;
      const deps = getQueryDeps(p.optionsQuery);
      if (deps.length === 0) {
        void fetchCandidates(p.name, p.optionsQuery, {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 値変化時: 依存クエリの再フェッチ
  const prevValuesRef = useRef(values);
  useEffect(() => {
    const prev = prevValuesRef.current;
    prevValuesRef.current = values;
    for (const p of params) {
      if (p.optionsQuery === undefined) continue;
      const deps = getQueryDeps(p.optionsQuery);
      if (deps.length === 0) continue;
      const changed = deps.some((dep) => prev[dep] !== values[dep]);
      if (changed) {
        const resolvedVars: Record<string, string> = {};
        for (const dep of deps) resolvedVars[dep] = values[dep] ?? '';
        void fetchCandidates(p.name, p.optionsQuery, resolvedVars);
      }
    }
  }, [values, params, fetchCandidates]);

  const setValue = useCallback((name: string, value: string): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
    // 入力中は実行結果表示をクリア (再試行モード)
    setRunResult(null);
    setRunError(null);
  }, []);

  const requiredMissing = useMemo(
    () =>
      params
        .filter((p) => p.required === true && (values[p.name] ?? '').trim() === '')
        .map((p) => p.name),
    [params, values],
  );
  const canSubmit = requiredMissing.length === 0 && !busy;

  const submit = useCallback((): void => {
    if (busy) return;
    if (requiredMissing.length > 0) {
      setShowErrors(true);
      return;
    }
    setBusy(true);
    setRunResult(null);
    setRunError(null);
    void (async (): Promise<void> => {
      try {
        const result = await api.runCommand(runId, values);
        setBusy(false);
        // 実行が走った (全成功/部分失敗どちらでも) → ファイルが書かれた可能性 → サイドバー再取得
        onRan?.();
        const allOk = result.results.every((r) => r.ok);
        if (allOk) {
          onSuccess(result.openPath);
        } else {
          // 部分失敗: 結果表示
          setRunResult(result);
        }
      } catch (err) {
        setBusy(false);
        setRunError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [busy, runId, onSuccess, onRan, requiredMissing.length, values]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // パレットの global keydown リスナーに Esc が伝わらないようにする
        onCancel();
        return;
      }
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        const el = e.target as HTMLElement;
        // textarea 内の Enter は改行を優先 (submit にしない)
        if (el.tagName.toLowerCase() === 'textarea') return;
        e.preventDefault();
        submit();
      }
    },
    [onCancel, submit],
  );

  // 最初の入力欄へ自動フォーカス
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  // 実行結果の成功/失敗カウント
  const successCount = runResult?.results.filter((r) => r.ok).length ?? 0;
  const failureCount = runResult?.results.filter((r) => !r.ok).length ?? 0;
  const totalCount = runResult?.results.length ?? 0;
  const hasResult = runResult !== null || runError !== null;
  const isFailure = runResult !== null
    ? runResult.results.some((r) => !r.ok)
    : runError !== null;

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
          <span className={`param-h-ico${isFailure && hasResult ? ' failure' : ''}`}>
            {isFailure && hasResult ? (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 5v4M8 11h.01" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="10" height="10" rx="2" />
                <path d="M6 8l2 2 3-3" />
              </svg>
            )}
          </span>
          <div className="param-h-main">
            <h2 data-testid="param-form-title">
              {hasResult && isFailure ? `${commandName} — 実行エラー` : commandName}
            </h2>
            {hasResult && isFailure ? (
              <div className="sub">
                {totalCount} ステップ中 {successCount} ステップ完了・{failureCount} ステップ失敗
              </div>
            ) : description !== undefined ? (
              <div className="sub">{description}</div>
            ) : null}
          </div>
          <button
            className="icon-btn"
            data-testid="param-form-close"
            title={hasResult ? '閉じる (Esc)' : 'キャンセル (Esc)'}
            onClick={onCancel}
          >
            <CloseIcon />
          </button>
        </div>

        {/* パラメータフィールド (結果表示中は非表示にしない — 再試行できるよう残す) */}
        {!hasResult && (
          <div className="param-fields">
            {params.map((p, i) => {
              const invalid = showErrors && requiredMissing.includes(p.name);
              const label = p.label ?? p.name;
              const fieldType = p.type ?? 'string';
              const csState = candidateStates[p.name] ?? { status: 'idle' };
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
                    {/* ローディングインジケータ (S1bd397-4) */}
                    {p.optionsQuery !== undefined && csState.status === 'loading' && (
                      <div
                        className="param-options-hint param-options-loading"
                        data-testid="param-field-options-loading"
                        data-name={p.name}
                      >
                        候補を取得中…
                      </div>
                    )}
                    {/* 0件ヒント (S1bd397-4) */}
                    {p.optionsQuery !== undefined && csState.status === 'loaded' && csState.candidates.length === 0 && (
                      <div
                        className="param-options-hint param-options-empty"
                        data-testid="param-field-options-empty"
                        data-name={p.name}
                      >
                        候補なし。直接入力してください
                      </div>
                    )}
                    <ParamFieldInput
                      param={p}
                      value={values[p.name] ?? ''}
                      invalid={invalid}
                      onChange={(v) => setValue(p.name, v)}
                      inputRef={i === 0 ? firstInputRef : undefined}
                      candidateState={csState}
                    />
                    {invalid && (
                      <div
                        className="param-field-error"
                        data-testid="param-field-error"
                        data-name={p.name}
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                          <circle cx="8" cy="8" r="6" />
                          <path d="M8 5v4M8 11h.01" />
                        </svg>
                        {label}は必須です
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 実行結果表示 */}
        {hasResult && (
          <div className="param-form-result" data-testid="param-form-result">
            <div className={`param-form-result-head${isFailure ? ' failure' : ' success'}`}>
              {isFailure ? (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="8" cy="8" r="6" />
                  <path d="M8 5v4M8 11h.01" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="8" cy="8" r="6" />
                  <path d="M5.5 8l2 2 3-3" />
                </svg>
              )}
              {isFailure ? '実行失敗' : '実行成功'}
            </div>
            {runResult !== null &&
              runResult.results.map((step, idx) => (
                <div
                  key={`${step.kind}-${idx}`}
                  className="step-result"
                  data-testid="step-result"
                  data-kind={step.kind}
                  data-ok={step.ok ? 'true' : 'false'}
                >
                  {step.ok ? (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <circle cx="8" cy="8" r="6" />
                      <path d="M5.5 8l2 2 3-3" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  )}
                  <span className="step-kind">{step.kind}</span>
                  {step.path !== undefined && (
                    <span>{step.path}</span>
                  )}
                  {step.error !== undefined && (
                    <span>{step.error}</span>
                  )}
                </div>
              ))}
            {runError !== null && (
              <div
                className="step-result"
                data-testid="step-result"
                data-kind="request"
                data-ok="false"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
                <span className="step-kind">request</span>
                <span>{runError}</span>
              </div>
            )}
          </div>
        )}

        {hasResult && isFailure && (
          <div style={{ padding: '12px 18px', fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
            パラメータを修正して再度お試しください。
          </div>
        )}

        {/* フッタ */}
        <div className="param-modal-foot">
          <div className="param-kbd-hints">
            {hasResult ? (
              <span>
                <kbd>Esc</kbd> パレットへ戻る
              </span>
            ) : (
              <>
                <span>
                  <kbd>Tab</kbd> 移動
                </span>
                <span>
                  <kbd>Enter</kbd> 実行
                </span>
                <span>
                  <kbd>Esc</kbd> 戻る
                </span>
              </>
            )}
          </div>
          <div className="param-foot-actions">
            <button className="btn" data-testid="param-form-cancel" onClick={onCancel}>
              {hasResult ? '閉じる' : 'キャンセル'}
            </button>
            {/* aria-disabled (not native disabled) を使うことで onClick が発火し、
                required 未入力時にインラインエラーを表示できる (F-2: 意図的) */}
            <button
              className="btn primary"
              data-testid="param-form-submit"
              aria-disabled={!canSubmit ? 'true' : undefined}
              onClick={() => {
                if (hasResult) {
                  // 再試行: 結果をクリアしてフォームに戻る
                  setRunResult(null);
                  setRunError(null);
                  setShowErrors(false);
                } else {
                  submit();
                }
              }}
            >
              {hasResult ? '再試行' : '実行'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- パラメータ入力欄 ----

interface ParamFieldInputProps {
  param: CommandParam;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  inputRef?: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null> | undefined;
  candidateState: CandidateState;
}

function ParamFieldInput({ param, value, invalid, onChange, inputRef, candidateState: cs }: ParamFieldInputProps): JSX.Element {
  const fieldType = param.type ?? 'string';

  // select+optionsQuery → 動的ドロップダウン (S1bd397-4)
  if (fieldType === 'select' && param.optionsQuery !== undefined) {
    const isLoading = cs.status === 'loading' || cs.status === 'idle';
    const candidates = cs.status === 'loaded' ? cs.candidates : [];
    const hasNoCandidate = cs.status === 'loaded' && candidates.length === 0;
    const isError = cs.status === 'error';

    // 0件またはエラー → フォールバック自由入力
    if (hasNoCandidate || isError) {
      return (
        <input
          className={`param-input${invalid ? ' invalid' : ''}`}
          data-testid="param-field-input"
          data-name={param.name}
          type="text"
          value={value}
          placeholder={param.label ?? param.name}
          autoComplete="off"
          aria-invalid={invalid ? 'true' : undefined}
          onChange={(e) => onChange(e.target.value)}
          ref={(el) => {
            if (inputRef !== undefined) inputRef.current = el;
          }}
        />
      );
    }

    return (
      <select
        className={`param-input${invalid ? ' invalid' : ''}`}
        data-testid="param-field-input"
        data-name={param.name}
        data-widget="dynamic-select"
        value={value}
        disabled={isLoading}
        aria-busy={isLoading ? 'true' : undefined}
        aria-invalid={invalid ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
        ref={(el) => {
          if (inputRef !== undefined) inputRef.current = el as unknown as HTMLInputElement;
        }}
      >
        {candidates.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }

  // note+optionsQuery → ノートピッカー (S1bd397-4)
  if (fieldType === 'note' && param.optionsQuery !== undefined) {
    const candidates = cs.status === 'loaded' ? cs.candidates : [];
    const listId = `param-datalist-note-${param.name}`;
    return (
      <>
        <input
          className={`param-input${invalid ? ' invalid' : ''}`}
          data-testid="param-field-input"
          data-name={param.name}
          data-widget="note-picker"
          type="text"
          list={listId}
          value={value}
          placeholder={param.label ?? param.name}
          autoComplete="off"
          aria-invalid={invalid ? 'true' : undefined}
          onChange={(e) => onChange(e.target.value)}
          ref={(el) => {
            if (inputRef !== undefined) inputRef.current = el;
          }}
        />
        <datalist id={listId}>
          {candidates.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </datalist>
      </>
    );
  }

  // text+optionsQuery → オートコンプリート (S1bd397-4)
  if (fieldType === 'text' && param.optionsQuery !== undefined) {
    const candidates = cs.status === 'loaded' ? cs.candidates : [];
    const listId = `param-datalist-text-${param.name}`;
    return (
      <>
        <textarea
          className={`param-input${invalid ? ' invalid' : ''}`}
          data-testid="param-field-input"
          data-name={param.name}
          data-widget="autocomplete"
          rows={3}
          value={value}
          placeholder={param.label ?? param.name}
          autoComplete="off"
          aria-invalid={invalid ? 'true' : undefined}
          onChange={(e) => onChange(e.target.value)}
          ref={(el) => {
            if (inputRef !== undefined) inputRef.current = el;
          }}
        />
        <datalist id={listId}>
          {candidates.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </datalist>
      </>
    );
  }

  // type='text' (optionsQuery なし) → textarea (複数行)
  if (fieldType === 'text') {
    return (
      <textarea
        className={`param-input${invalid ? ' invalid' : ''}`}
        data-testid="param-field-input"
        data-name={param.name}
        rows={3}
        value={value}
        placeholder={param.label ?? param.name}
        autoComplete="off"
        aria-invalid={invalid ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
        ref={(el) => {
          if (inputRef !== undefined) inputRef.current = el;
        }}
      />
    );
  }

  // type='date' → input[type=date]
  if (fieldType === 'date') {
    return (
      <input
        className={`param-input${invalid ? ' invalid' : ''}`}
        data-testid="param-field-input"
        data-name={param.name}
        type="date"
        value={value}
        autoComplete="off"
        aria-invalid={invalid ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
        ref={(el) => {
          if (inputRef !== undefined) inputRef.current = el;
        }}
      />
    );
  }

  // type='string' (or default) → input[type=text]
  return (
    <input
      className={`param-input${invalid ? ' invalid' : ''}`}
      data-testid="param-field-input"
      data-name={param.name}
      type="text"
      value={value}
      placeholder={param.label ?? param.name}
      autoComplete="off"
      aria-invalid={invalid ? 'true' : undefined}
      onChange={(e) => onChange(e.target.value)}
      ref={(el) => {
        if (inputRef !== undefined) inputRef.current = el;
      }}
    />
  );
}
