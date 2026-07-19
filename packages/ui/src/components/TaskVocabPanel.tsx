/**
 * タスク語彙設定パネル (Se3b7a2-8)。
 *
 * - GET /api/settings/tasks でステータス・優先度語彙をロードする。
 * - 2 カラムレイアウト: 左=語彙エディタ (テーブル)、右=スティッキー YAML プレビュー。
 * - 変更は PUT /api/settings/tasks で保存。
 * - 読み取り専用モードでは入力を disabled にする。
 *
 * [AC-Se3b7a2-8-1] [AC-Se3b7a2-8-2]
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { api } from '../api.js';
import {
  DEFAULT_TASK_VOCAB,
  serializeTaskVocab,
  type TaskStatusEntry,
  type TaskPriorityEntry,
  type TaskVocabRequired,
} from '@loamium/shared';

// ---- アイコン ----------------------------------------------------------------

function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M3 4.5h10M6.5 4V3h3v1M5 4.5l.5 8h5l.5-8" />
    </svg>
  );
}

// ---- Switch ----------------------------------------------------------------

function SmallSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className="switch switch-sm"
      data-testid="task-status-done-toggle"
      onClick={() => onChange(!checked)}
    />
  );
}

// ---- Props -----------------------------------------------------------------

interface TaskVocabPanelProps {
  mode: 'full' | 'append-only' | 'read-only';
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// ---- Panel -----------------------------------------------------------------

export function TaskVocabPanel({ mode }: TaskVocabPanelProps): JSX.Element {
  const readonly = mode !== 'full';

  const [statuses, setStatuses] = useState<TaskStatusEntry[]>(DEFAULT_TASK_VOCAB.statuses);
  const [priorities, setPriorities] = useState<TaskPriorityEntry[]>(DEFAULT_TASK_VOCAB.priorities);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [loading, setLoading] = useState(true);

  // ---- ロード ----

  const loadVocab = useCallback((): void => {
    setLoading(true);
    void api.getTaskVocab().then((vocab) => {
      setStatuses([...vocab.statuses]);
      setPriorities([...vocab.priorities]);
      setLoading(false);
    }).catch(() => {
      setStatuses([...DEFAULT_TASK_VOCAB.statuses]);
      setPriorities([...DEFAULT_TASK_VOCAB.priorities]);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadVocab(); }, [loadVocab]);

  // ---- YAML プレビュー ----

  const yamlPreview = serializeTaskVocab({ statuses, priorities });

  // ---- 保存 ----

  const save = useCallback((): void => {
    setSaveStatus('saving');
    const vocab: TaskVocabRequired = { statuses, priorities };
    void api.putTaskVocab(vocab).then(() => {
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    }).catch(() => {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    });
  }, [statuses, priorities]);

  // ---- リセット ----

  const reset = useCallback((): void => {
    loadVocab();
    setSaveStatus('idle');
  }, [loadVocab]);

  // ---- Status 操作 ----

  const updateStatus = (idx: number, patch: Partial<TaskStatusEntry>): void => {
    setStatuses((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const removeStatus = (idx: number): void => {
    setStatuses((prev) => prev.filter((_, i) => i !== idx));
  };

  const addStatus = (): void => {
    setStatuses((prev) => [
      ...prev,
      { key: '', label: '', color: '#64748b' },
    ]);
  };

  // ---- Priority 操作 ----

  const updatePriority = (idx: number, patch: Partial<TaskPriorityEntry>): void => {
    setPriorities((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const removePriority = (idx: number): void => {
    setPriorities((prev) => prev.filter((_, i) => i !== idx));
  };

  const addPriority = (): void => {
    setPriorities((prev) => [
      ...prev,
      { key: '', label: '', color: '#64748b' },
    ]);
  };

  // ---- 描画 ----

  if (loading) {
    return (
      <div data-testid="settings-tasks" className="settings-main">
        <div className="settings-head">
          <h1>タスク語彙</h1>
        </div>
        <p>読み込み中…</p>
      </div>
    );
  }

  const saveLabel =
    saveStatus === 'saving' ? '保存中…'
    : saveStatus === 'saved' ? '保存済み ✓'
    : saveStatus === 'error' ? 'エラー'
    : '保存';

  return (
    <div data-testid="settings-tasks" className="settings-main">
      <div className="settings-head">
        <h1>タスク語彙</h1>
        <span
          className="settings-status"
          data-testid="settings-status"
          data-state={saveStatus}
        >
          {saveStatus === 'saved' && '✓ 保存済み'}
          {saveStatus === 'error' && '保存エラー'}
        </span>
      </div>
      <p className="settings-sub">
        ステータス・優先度の語彙を定義します。設定は <code>system/settings.yaml</code> の{' '}
        <code>tasks:</code> に保存されます。
      </p>

      <div className="vocab-layout">
        {/* ---- 左: 語彙エディタ ---- */}
        <div>
          {/* ステータス語彙 */}
          <div className="vocab-section">
            <div className="vocab-section-head">
              <h2>ステータス</h2>
              <span className="section-count">{statuses.length}</span>
            </div>
            <table className="vocab-table">
              <thead>
                <tr>
                  <th>キー</th>
                  <th>ラベル</th>
                  <th>色</th>
                  <th>完了扱い</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {statuses.map((s, idx) => (
                  <tr key={idx} data-testid="task-status-row" data-key={s.key}>
                    <td className="vocab-key-cell">
                      <input
                        type="text"
                        value={s.key}
                        disabled={readonly}
                        aria-label="ステータスキー"
                        onChange={(e) => updateStatus(idx, { key: e.target.value })}
                      />
                    </td>
                    <td className="vocab-label-cell">
                      <input
                        type="text"
                        value={s.label}
                        disabled={readonly}
                        aria-label="ステータスラベル"
                        onChange={(e) => updateStatus(idx, { label: e.target.value })}
                      />
                    </td>
                    <td>
                      <div className="color-cell">
                        <span
                          className="color-swatch"
                          style={{ background: s.color ?? '#64748b' }}
                        />
                        <input
                          type="color"
                          value={s.color ?? '#64748b'}
                          disabled={readonly}
                          aria-label="色"
                          onChange={(e) => updateStatus(idx, { color: e.target.value })}
                        />
                      </div>
                    </td>
                    <td>
                      <SmallSwitch
                        checked={s.done === true}
                        onChange={(v) => updateStatus(idx, { done: v || undefined })}
                        disabled={readonly}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-danger-ghost btn-sm"
                        disabled={readonly}
                        aria-label="削除"
                        onClick={() => removeStatus(idx)}
                      >
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="task-status-add"
              disabled={readonly}
              style={{ marginTop: '8px' }}
              onClick={addStatus}
            >
              + ステータスを追加
            </button>
          </div>

          {/* 優先度語彙 */}
          <div className="vocab-section">
            <div className="vocab-section-head">
              <h2>優先度</h2>
              <span className="section-count">{priorities.length}</span>
            </div>
            <table className="vocab-table">
              <thead>
                <tr>
                  <th>キー</th>
                  <th>ラベル</th>
                  <th>色</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {priorities.map((p, idx) => (
                  <tr key={idx} data-testid="task-priority-row" data-key={p.key}>
                    <td className="vocab-key-cell">
                      <input
                        type="text"
                        value={p.key}
                        disabled={readonly}
                        aria-label="優先度キー"
                        onChange={(e) => updatePriority(idx, { key: e.target.value })}
                      />
                    </td>
                    <td className="vocab-label-cell">
                      <input
                        type="text"
                        value={p.label}
                        disabled={readonly}
                        aria-label="優先度ラベル"
                        onChange={(e) => updatePriority(idx, { label: e.target.value })}
                      />
                    </td>
                    <td>
                      <div className="color-cell">
                        <span
                          className="color-swatch"
                          style={{ background: p.color ?? '#64748b' }}
                        />
                        <input
                          type="color"
                          value={p.color ?? '#64748b'}
                          disabled={readonly}
                          aria-label="色"
                          onChange={(e) => updatePriority(idx, { color: e.target.value })}
                        />
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-danger-ghost btn-sm"
                        disabled={readonly}
                        aria-label="削除"
                        onClick={() => removePriority(idx)}
                      >
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="task-priority-add"
              disabled={readonly}
              style={{ marginTop: '8px' }}
              onClick={addPriority}
            >
              + 優先度を追加
            </button>
          </div>

          {/* アクション */}
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="settings-save"
              data-group="tasks"
              disabled={readonly || saveStatus === 'saving'}
              onClick={save}
            >
              {saveLabel}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="settings-reset"
              disabled={readonly || saveStatus === 'saving'}
              onClick={reset}
            >
              リセット
            </button>
          </div>
        </div>

        {/* ---- 右: YAML プレビュー ---- */}
        <div style={{ position: 'sticky', top: '24px', alignSelf: 'start' }}>
          <div className="vocab-section">
            <div className="vocab-section-head">
              <h2>YAML プレビュー</h2>
            </div>
            <pre
              data-testid="tasks-yaml-preview"
              className="yaml-preview"
              style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: '12px',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '12px 14px',
                overflow: 'auto',
                maxHeight: '480px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {yamlPreview}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
