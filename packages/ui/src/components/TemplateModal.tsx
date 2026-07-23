/**
 * テンプレート変数入力モーダル (S89a350-3)。
 *
 * ビジュアルの正: prototype/templates/modal.html。
 * 入力ウィジェットは property-types と同じ見た目 (text/select/date/tags) を流用し、
 * キーボードで完結する (Tab 項目移動 / Enter 作成 / Esc 中断 / ←→ で select 切替)。
 * 必須変数が未入力なら確定不可 + インラインエラー。保存先はライブプレビューする。
 *
 * S1bd397-4: optionsQuery 対応 (dynamic-select / autocomplete)。
 *   - select+optionsQuery → <select> 動的ドロップダウン (data-widget="dynamic-select")
 *   - text+optionsQuery  → <input>+<datalist> オートコンプリート (data-widget="autocomplete")
 *   - 依存クエリ: 上流変数変化で再フェッチ
 *
 * data-testid (prototype/TESTIDS.md 準拠):
 *   template-modal-backdrop / template-modal / template-target-preview
 *   template-var-input (data-var) / template-var-error (data-var)
 *   template-create / template-cancel
 *   template-var-options-loading (data-var) / template-var-options-empty (data-var)
 *   template-var-options-truncated (data-var)
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { resolveTemplate, todayJournalDate, type TemplateSummary, type TemplateVar } from '@loamium/shared';
import { CloseIcon } from '../icons.js';
import { api } from '../api.js';

interface TemplateModalProps {
  template: TemplateSummary;
  /** 作成を実行する (解決は server 側)。成功でモーダルは閉じられる。 */
  onCreate: (vars: Record<string, string>, date: string | undefined) => Promise<void>;
  onCancel: () => void;
}

/** date 型変数の初期値 (テンプレート default か今日)。 */
function initialValue(v: TemplateVar): string {
  if (v.default !== undefined) {
    // default はテンプレート記法を含みうる ({{date:YYYY-MM-DD}} など) — 今日基準で解決
    return resolveTemplate(v.default, { date: new Date(), now: new Date() }).text;
  }
  if (v.type === 'date') return todayJournalDate();
  if (v.type === 'select' && v.options !== undefined && v.options.length > 0 && v.optionsQuery === undefined) return v.options[0] ?? '';
  return '';
}

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

/** 候補フェッチ状態 */
type CandidateState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; candidates: { value: string; label: string }[]; truncated: boolean }
  | { status: 'error' };

export function TemplateModal(props: TemplateModalProps): JSX.Element {
  const { template } = props;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of template.vars) init[v.name] = initialValue(v);
    return init;
  });
  const [showErrors, setShowErrors] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | HTMLDivElement | null>(null);

  // 候補フェッチ状態: 変数名 → CandidateState
  const [candidateStates, setCandidateStates] = useState<Record<string, CandidateState>>(() => {
    const init: Record<string, CandidateState> = {};
    for (const v of template.vars) {
      init[v.name] = v.optionsQuery !== undefined ? { status: 'idle' } : { status: 'idle' };
    }
    return init;
  });

  // 日付型変数があれば {{date:...}} の基準日として使う (prototype: 日付フィールドが
  // 保存先プレビューを駆動する)。
  const dateVar = useMemo(() => template.vars.find((v) => v.type === 'date'), [template.vars]);
  const dateValue = dateVar !== undefined ? values[dateVar.name] : undefined;
  const dateBase = useMemo(() => {
    if (dateValue !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      const [y, m, d] = dateValue.split('-').map(Number);
      return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
    }
    return new Date();
  }, [dateValue]);

  const setValue = useCallback((name: string, value: string): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setSubmitError(null);
  }, []);

  // optionsQuery を持つ変数のフェッチ
  const fetchCandidates = useCallback(
    async (varName: string, dql: string, resolvedVars: Record<string, string>): Promise<void> => {
      setCandidateStates((prev) => ({ ...prev, [varName]: { status: 'loading' } }));
      try {
        const interpolated = interpolateQuery(dql, resolvedVars);
        const resp = await api.queryOptions(interpolated);
        setCandidateStates((prev) => ({
          ...prev,
          [varName]: { status: 'loaded', candidates: resp.candidates, truncated: resp.truncated },
        }));
        // 候補が1件以上あれば最初の候補を初期値に設定 (値が空の場合)
        if (resp.candidates.length > 0) {
          setValues((prev) => {
            const cur = prev[varName] ?? '';
            if (cur === '' || !resp.candidates.some((c) => c.value === cur)) {
              return { ...prev, [varName]: resp.candidates[0]?.value ?? '' };
            }
            return prev;
          });
        } else {
          // 0件: 現在値をリセットしない (自由入力フォールバック)
        }
      } catch {
        setCandidateStates((prev) => ({ ...prev, [varName]: { status: 'error' } }));
      }
    },
    [],
  );

  // 初回マウント時: 依存なし optionsQuery 変数をフェッチ
  useEffect(() => {
    for (const v of template.vars) {
      if (v.optionsQuery === undefined) continue;
      const deps = getQueryDeps(v.optionsQuery);
      if (deps.length === 0) {
        void fetchCandidates(v.name, v.optionsQuery, {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 変数値変化時: 依存クエリの再フェッチ
  const prevValuesRef = useRef(values);
  useEffect(() => {
    const prev = prevValuesRef.current;
    prevValuesRef.current = values;

    for (const v of template.vars) {
      if (v.optionsQuery === undefined) continue;
      const deps = getQueryDeps(v.optionsQuery);
      if (deps.length === 0) continue;
      // 上流変数のどれかが変化したか確認
      const changed = deps.some((dep) => prev[dep] !== values[dep]);
      if (changed) {
        // 上流値を resolvedVars として注入して再フェッチ
        const resolvedVars: Record<string, string> = {};
        for (const dep of deps) resolvedVars[dep] = values[dep] ?? '';
        void fetchCandidates(v.name, v.optionsQuery, resolvedVars);
      }
    }
  }, [values, template.vars, fetchCandidates]);

  const requiredMissing = useMemo(
    () => template.vars.filter((v) => v.required && (values[v.name] ?? '').trim() === '').map((v) => v.name),
    [template.vars, values],
  );
  const canCreate = requiredMissing.length === 0;

  // 保存先ライブプレビュー: 空の変数はトークンのまま残す (prototype 準拠)。
  const targetPattern = template.target ?? template.name;
  const previewText = useMemo(() => {
    const nonEmpty: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim() !== '') nonEmpty[k] = v;
    const resolved = resolveTemplate(targetPattern, {
      vars: nonEmpty,
      date: dateBase,
      now: new Date(),
      pathMode: true,
    }).text;
    return /\.md$/i.test(resolved) ? resolved : `${resolved}.md`;
  }, [targetPattern, values, dateBase]);

  const submit = useCallback((): void => {
    if (busy) return;
    if (!canCreate) {
      setShowErrors(true);
      return;
    }
    setBusy(true);
    const date = dateVar !== undefined ? dateValue : undefined;
    void props
      .onCreate(values, date)
      .catch((err: unknown) => {
        setSubmitError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  }, [busy, canCreate, dateVar, dateValue, props, values]);

  // ---- キーボード完結 (Enter=作成 / Esc=中断)。tags 入力中の Enter は除外 ----
  const onKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onCancel();
        return;
      }
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        const el = e.target as HTMLElement;
        // tags 追加入力中の Enter はチップ追加を優先 (モーダル確定にしない)
        if (el.dataset.role === 'tag-input') return;
        e.preventDefault();
        submit();
      }
    },
    [props, submit],
  );

  useEffect(() => {
    // 最初の入力欄へフォーカス (キーボード完結)
    const el = firstFieldRef.current;
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    } else {
      el?.focus();
    }
  }, []);

  return (
    <div
      className="dialog-backdrop"
      data-testid="template-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className="tpl-modal"
        data-testid="template-modal"
        role="dialog"
        aria-label={`${template.name} テンプレートの変数を入力`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="tpl-modal-head">
          <div className="tpl-h-main">
            <h2>{template.name} テンプレート</h2>
            {template.target !== null && (
              <div className="sub">
                保存先パターン <code>{template.target}</code>
              </div>
            )}
          </div>
          <button
            className="icon-btn"
            data-testid="template-cancel"
            title="中断 (Esc)"
            onClick={props.onCancel}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="tpl-target-label">保存先(入力に応じてライブ更新)</div>
        <div className="tpl-target" data-testid="template-target-preview">
          <span className="arrow">→</span>
          <span className="tpl-target-path">{previewText}</span>
        </div>

        <div className="tpl-vars">
          {template.vars.length === 0 && (
            <div className="tpl-tag-hint">このテンプレートに入力変数はありません。作成できます。</div>
          )}
          {template.vars.map((v, i) => {
            const invalid = showErrors && requiredMissing.includes(v.name);
            const csState = candidateStates[v.name] ?? { status: 'idle' };
            return (
              <div
                key={v.name}
                className={`tpl-var-row${invalid ? ' invalid' : ''}`}
                data-var={v.name}
              >
                <label className="tpl-var-label">
                  {v.label ?? v.name}
                  {v.required ? (
                    <span className="req" title="必須">
                      *
                    </span>
                  ) : (
                    <span className="opt">任意</span>
                  )}
                </label>
                <div className="tpl-var-field">
                  {/* ローディングインジケータ */}
                  {csState.status === 'loading' && (
                    <div
                      className="tpl-options-hint tpl-options-loading"
                      data-testid="template-var-options-loading"
                      data-var={v.name}
                    >
                      候補を取得中…
                    </div>
                  )}
                  {/* 0件ヒント */}
                  {csState.status === 'loaded' && csState.candidates.length === 0 && (
                    <div
                      className="tpl-options-hint tpl-options-empty"
                      data-testid="template-var-options-empty"
                      data-var={v.name}
                    >
                      候補なし。直接入力してください
                    </div>
                  )}
                  {/* 打ち切りヒント */}
                  {csState.status === 'loaded' && csState.truncated && (
                    <div
                      className="tpl-options-hint tpl-options-truncated"
                      data-testid="template-var-options-truncated"
                      data-var={v.name}
                    >
                      件数が多いため一部のみ表示
                    </div>
                  )}
                  <VarInput
                    variable={v}
                    value={values[v.name] ?? ''}
                    onChange={(value) => setValue(v.name, value)}
                    inputRef={i === 0 ? firstFieldRef : undefined}
                    candidateState={csState}
                  />
                  {invalid && (
                    <div
                      className="tpl-error"
                      data-testid="template-var-error"
                      data-var={v.name}
                      style={{ display: 'flex' }}
                    >
                      {(v.label ?? v.name)}は必須です。
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {submitError !== null && (
          <div className="dialog-error" data-testid="template-submit-error" style={{ margin: '0 18px' }}>
            {submitError}
          </div>
        )}

        <div className="tpl-modal-foot">
          <div className="tpl-kbd-hints">
            <span>
              <kbd>Tab</kbd> 項目移動
            </span>
            <span>
              <kbd>Enter</kbd> 作成
            </span>
            <span>
              <kbd>Esc</kbd> 中断
            </span>
          </div>
          <div className="tpl-foot-actions">
            <button className="btn" data-testid="template-cancel" onClick={props.onCancel}>
              キャンセル
            </button>
            <button
              className="btn primary tpl-create"
              data-testid="template-create"
              aria-disabled={!canCreate || busy}
              onClick={submit}
            >
              作成
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface VarInputProps {
  variable: TemplateVar;
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.MutableRefObject<HTMLInputElement | HTMLDivElement | null> | undefined;
  candidateState: CandidateState;
}

function VarInput(props: VarInputProps): JSX.Element {
  const { variable: v, value, candidateState: cs } = props;

  // select+optionsQuery → 動的ドロップダウン
  if (v.type === 'select' && v.optionsQuery !== undefined) {
    const isLoading = cs.status === 'loading' || cs.status === 'idle';
    const candidates = cs.status === 'loaded' ? cs.candidates : [];
    const hasNoCandidate = cs.status === 'loaded' && candidates.length === 0;
    const isError = cs.status === 'error';

    // 0件またはエラー → フォールバック自由入力
    if (hasNoCandidate || isError) {
      return (
        <input
          className="tpl-input"
          data-testid="template-var-input"
          data-var={v.name}
          type="text"
          value={value}
          autoComplete="off"
          onChange={(e) => props.onChange(e.target.value)}
          ref={(el) => {
            if (props.inputRef) props.inputRef.current = el;
          }}
        />
      );
    }

    return (
      <select
        className="tpl-input tpl-dynamic-select"
        data-testid="template-var-input"
        data-var={v.name}
        data-widget="dynamic-select"
        value={value}
        disabled={isLoading}
        aria-busy={isLoading ? 'true' : undefined}
        onChange={(e) => props.onChange(e.target.value)}
        ref={(el) => {
          if (props.inputRef) props.inputRef.current = el as unknown as HTMLInputElement;
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

  // text+optionsQuery → オートコンプリート (input + datalist)
  if (v.optionsQuery !== undefined) {
    const listId = `tpl-datalist-${v.name}`;
    const candidates = cs.status === 'loaded' ? cs.candidates : [];
    return (
      <>
        <input
          className="tpl-input"
          data-testid="template-var-input"
          data-var={v.name}
          data-widget="autocomplete"
          type="text"
          list={listId}
          value={value}
          autoComplete="off"
          onChange={(e) => props.onChange(e.target.value)}
          ref={(el) => {
            if (props.inputRef) props.inputRef.current = el;
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

  // 静的 select (optionsQuery なし)
  if (v.type === 'select') {
    const options = v.options ?? [];
    return (
      <div
        className="tpl-select-opts"
        role="radiogroup"
        data-testid="template-var-input"
        data-var={v.name}
        ref={(el) => {
          if (props.inputRef) props.inputRef.current = el;
        }}
      >
        {options.map((opt, i) => {
          const on = opt === value;
          return (
            <button
              key={opt}
              type="button"
              className={`tpl-opt${on ? ' sel' : ''}`}
              role="radio"
              aria-checked={on}
              data-value={opt}
              tabIndex={on || (value === '' && i === 0) ? 0 : -1}
              onClick={() => props.onChange(opt)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  props.onChange(options[(i + 1) % options.length] ?? opt);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  props.onChange(options[(i - 1 + options.length) % options.length] ?? opt);
                }
              }}
            >
              <span className="dot" />
              {opt}
            </button>
          );
        })}
      </div>
    );
  }

  if (v.type === 'tags') {
    return (
      <TagsInput
        name={v.name}
        value={value}
        onChange={props.onChange}
        inputRef={props.inputRef}
      />
    );
  }

  // text / date
  return (
    <input
      className={v.type === 'date' ? 'tpl-input date' : 'tpl-input'}
      data-testid="template-var-input"
      data-var={v.name}
      type={v.type === 'date' ? 'date' : 'text'}
      value={value}
      autoComplete="off"
      onChange={(e) => props.onChange(e.target.value)}
      ref={(el) => {
        if (props.inputRef) props.inputRef.current = el;
      }}
    />
  );
}

interface TagsInputProps {
  name: string;
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.MutableRefObject<HTMLInputElement | HTMLDivElement | null> | undefined;
}

/** tags ウィジェット: チップ + 追加入力。値は ", " 区切りの文字列で保持する。 */
function TagsInput(props: TagsInputProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const tags = props.value === '' ? [] : props.value.split(',').map((t) => t.trim()).filter((t) => t !== '');

  const commit = (next: string[]): void => props.onChange(next.join(', '));

  return (
    <div className="tpl-tags" data-testid="template-var-input" data-var={props.name}>
      {tags.map((t) => (
        <span key={t} className="pc-tag">
          {t}
          <span
            className="x"
            title="削除"
            role="button"
            onClick={() => commit(tags.filter((x) => x !== t))}
          >
            ×
          </span>
        </span>
      ))}
      <input
        className="tpl-tag-input"
        data-role="tag-input"
        type="text"
        value={draft}
        placeholder="入力して Enter"
        autoComplete="off"
        ref={(el) => {
          if (props.inputRef) props.inputRef.current = el;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const t = draft.trim();
            if (t !== '' && !tags.includes(t)) commit([...tags, t]);
            setDraft('');
          } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
            commit(tags.slice(0, -1));
          }
        }}
      />
    </div>
  );
}
