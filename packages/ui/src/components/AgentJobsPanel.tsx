import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, type AgentJob, type AgentJobWithState, type AgentJobRunResponse } from '../api.js';
import { CronBuilder } from './CronBuilder.js';

const ALL_CAPS = [
  { id: 'read', label: '読み取り' },
  { id: 'journal_append', label: 'ジャーナル追記' },
  { id: 'note_create', label: 'ノート作成' },
  { id: 'note_edit', label: 'ノート編集' },
  { id: 'template_write', label: 'テンプレート書込' },
  { id: 'web', label: 'Web アクセス' },
] as const;

type Cap = typeof ALL_CAPS[number]['id'];

interface AgentJobsPanelProps {
  mode: 'full' | 'append-only' | 'read-only';
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type RunStatus = 'idle' | 'running' | 'done' | 'error';

function normalizePerms(permissions: AgentJob['permissions']): Cap[] {
  if (!permissions) return ['read'];
  if (typeof permissions === 'string') {
    if (permissions === 'full') return ALL_CAPS.map((c) => c.id) as Cap[];
    if (permissions === 'notes-rw') return ['read', 'note_create', 'note_edit'] as Cap[];
    return ['read'];
  }
  return permissions.filter((p: string): p is Cap => ALL_CAPS.some((c) => c.id === p));
}

interface JobDraft {
  name: string;
  schedule: string;
  prompt: string;
  permissions: Cap[];
  enabled: boolean;
  maxTurns: number;
  timeoutSec: number;
}

function jobToJobDraft(j: AgentJob): JobDraft {
  return {
    name: j.name,
    schedule: j.schedule,
    prompt: j.prompt,
    permissions: normalizePerms(j.permissions),
    enabled: j.enabled,
    maxTurns: j.maxTurns,
    timeoutSec: j.timeoutSec,
  };
}

function draftToJob(d: JobDraft): AgentJob {
  return {
    name: d.name.trim(),
    schedule: d.schedule.trim(),
    prompt: d.prompt,
    permissions: d.permissions,
    enabled: d.enabled,
    maxTurns: d.maxTurns,
    timeoutSec: d.timeoutSec,
  };
}

const DEFAULT_DRAFT: JobDraft = {
  name: '',
  schedule: '0 8 * * *',
  prompt: '',
  permissions: ['read'],
  enabled: true,
  maxTurns: 20,
  timeoutSec: 120,
};

// ── アイコン ──────────────────────────────────────────────────────────────────

function IconAdd(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10"/>
    </svg>
  );
}

function IconClock(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5"/>
      <path d="M8 5v3.5l2 1.5"/>
    </svg>
  );
}

function IconPlay(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5 3.5l8 4.5-8 4.5V3.5z"/>
    </svg>
  );
}

function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M3 4h10M6 4V2h4v2M5 4l.5 9h5l.5-9"/>
    </svg>
  );
}

// ── メインコンポーネント ──────────────────────────────────────────────────────

export function AgentJobsPanel({ mode }: AgentJobsPanelProps): JSX.Element {
  const readonly = mode !== 'full';

  const [jobs, setJobs] = useState<AgentJobWithState[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<JobDraft | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [runResult, setRunResult] = useState<AgentJobRunResponse | null>(null);

  const loadJobs = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.getAgentJobs();
      setJobs(res.jobs);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const selectJob = useCallback((name: string | null) => {
    setSelectedName(name);
    setRunStatus('idle');
    setRunResult(null);
    setSaveStatus('idle');
    setSaveError(null);
    if (name === null) { setDraft(null); setIsDirty(false); return; }
    const j = jobs.find((x) => x.name === name);
    if (j) { setDraft(jobToJobDraft(j)); setIsDirty(false); }
  }, [jobs]);

  const addNew = useCallback(() => {
    setSelectedName('__new__');
    setDraft({ ...DEFAULT_DRAFT });
    setIsDirty(true);
    setSaveStatus('idle');
    setSaveError(null);
    setRunStatus('idle');
    setRunResult(null);
  }, []);

  const update = useCallback(<K extends keyof JobDraft>(k: K, v: JobDraft[K]) => {
    setDraft((d) => d === null ? d : { ...d, [k]: v });
    setIsDirty(true);
    setSaveStatus('idle');
  }, []);

  const toggleCap = useCallback((cap: Cap) => {
    setDraft((d) => {
      if (d === null) return d;
      const has = d.permissions.includes(cap);
      return { ...d, permissions: has ? d.permissions.filter((c) => c !== cap) : [...d.permissions, cap] };
    });
    setIsDirty(true);
    setSaveStatus('idle');
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaveStatus('saving');
    setSaveError(null);
    try {
      const updated = draftToJob(draft);
      const newJobs: AgentJob[] = selectedName === '__new__'
        ? [...jobs, updated]
        : jobs.map((j) => j.name === selectedName ? updated : j);
      await api.putAgentJobs(newJobs);
      setSaveStatus('saved');
      setIsDirty(false);
      setTimeout(() => setSaveStatus('idle'), 2000);
      await loadJobs();
      setSelectedName(updated.name);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [draft, jobs, selectedName, loadJobs]);

  const cancel = useCallback(() => {
    if (selectedName === '__new__') { setSelectedName(null); setDraft(null); setIsDirty(false); return; }
    const j = jobs.find((x) => x.name === selectedName);
    if (j) { setDraft(jobToJobDraft(j)); setIsDirty(false); }
    setSaveStatus('idle');
    setSaveError(null);
  }, [jobs, selectedName]);

  const deleteJob = useCallback(async () => {
    if (!selectedName || selectedName === '__new__') { setSelectedName(null); setDraft(null); return; }
    if (!window.confirm(`ジョブ "${selectedName}" を削除しますか？`)) return;
    setSaveStatus('saving');
    try {
      await api.putAgentJobs(jobs.filter((j) => j.name !== selectedName));
      setSelectedName(null);
      setDraft(null);
      setIsDirty(false);
      setSaveStatus('idle');
      await loadJobs();
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [jobs, selectedName, loadJobs]);

  const runNow = useCallback(async () => {
    if (!selectedName || selectedName === '__new__') return;
    setRunStatus('running');
    setRunResult(null);
    try {
      const res = await api.runAgentJob(selectedName);
      setRunResult(res);
      setRunStatus(res.ok ? 'done' : 'error');
      await loadJobs();
    } catch (err) {
      setRunStatus('error');
      setRunResult({ ok: false, result: 'error', error: String(err), durationMs: 0 });
    }
  }, [selectedName, loadJobs]);

  const selectedJobState = selectedName && selectedName !== '__new__'
    ? jobs.find((j) => j.name === selectedName)?.state
    : null;

  // 新規作成中は左リストにも仮エントリを表示する
  const listItems: Array<{ name: string; schedule: string; enabled: boolean }> =
    selectedName === '__new__' && draft !== null
      ? [...jobs, { name: '__new__', schedule: draft.schedule, enabled: draft.enabled }]
      : jobs;

  return (
    <div className="md-panel active" data-testid="agent-jobs-panel">
      {/* 左: ジョブ一覧 */}
      <div className="md-master">
        <div className="md-master-head">
          <h2>ジョブ</h2>
          {!readonly && (
            <button
              type="button"
              className="md-new"
              title="新規ジョブ"
              data-testid="agent-jobs-add"
              onClick={addNew}
            >
              <IconAdd />
            </button>
          )}
        </div>

        <div className="md-items" data-testid="agent-jobs-list">
          {loadError !== null && (
            <div className="md-items-empty" style={{ color: 'var(--danger, #e05263)' }}>{loadError}</div>
          )}
          {listItems.length === 0 && loadError === null && (
            <div className="md-items-empty">ジョブがありません</div>
          )}
          {listItems.map((j) => {
            const isNew = j.name === '__new__';
            const displayName = isNew && draft !== null ? (draft.name.trim() || '(新規)') : j.name;
            const isActive = selectedName === j.name || (isNew && selectedName === '__new__');
            return (
              <button
                key={j.name}
                type="button"
                className={`md-item${isActive ? ' active' : ''}`}
                data-testid="agent-jobs-item"
                onClick={() => { if (!isNew) selectJob(j.name); }}
              >
                <span className="ic" style={j.enabled ? {} : { opacity: 0.4 }}>
                  <IconClock />
                </span>
                <span className="txt">
                  <div className="nm">{displayName}</div>
                  <div className="sb mono">{j.schedule}</div>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右: 編集フォーム or 空状態 */}
      {draft !== null ? (
        <div className="md-detail">
          <div className="md-detail-header">
            <div className="detail-title-wrap">
              <input
                className="detail-title"
                data-testid="agent-jobs-name"
                type="text"
                value={draft.name}
                disabled={readonly || selectedName !== '__new__'}
                placeholder="ジョブ名 (英数字・ハイフン)"
                onChange={(e) => update('name', e.target.value)}
              />
            </div>
            {saveStatus === 'error' && <span className="md-save-error">{saveError}</span>}
            {saveStatus === 'saved' && <span className="md-save-ok">保存済み</span>}
            {saveStatus === 'saving' && <span className="md-save-error" style={{ color: 'var(--text-faint)' }}>保存中…</span>}
          </div>

          <div className="md-detail-body" style={{ padding: '20px 28px', gap: 18 }}>
            <div className="settings-field">
              <label>スケジュール</label>
              <CronBuilder
                value={draft.schedule}
                disabled={readonly}
                onChange={(cron) => update('schedule', cron)}
              />
            </div>

            <div className="settings-field">
              <label htmlFor="f-prompt">プロンプト</label>
              <textarea
                id="f-prompt"
                className="param-input"
                data-testid="agent-jobs-prompt"
                rows={6}
                value={draft.prompt}
                disabled={readonly}
                placeholder="エージェントに実行させたい指示を入力してください"
                onChange={(e) => update('prompt', e.target.value)}
                style={{ resize: 'vertical', minHeight: 100 }}
              />
            </div>

            <div className="settings-field">
              <label>権限 (ケーパビリティ)</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 20px', marginTop: 6 }}>
                {ALL_CAPS.map((c) => (
                  <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: readonly ? 'default' : 'pointer', fontSize: 13 }}>
                    <input
                      type="checkbox"
                      data-testid={`agent-jobs-cap-${c.id}`}
                      checked={draft.permissions.includes(c.id)}
                      disabled={readonly}
                      onChange={() => toggleCap(c.id)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="settings-field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: readonly ? 'default' : 'pointer', fontSize: 13 }}>
                <input
                  type="checkbox"
                  data-testid="agent-jobs-enabled"
                  checked={draft.enabled}
                  disabled={readonly}
                  onChange={(e) => update('enabled', e.target.checked)}
                />
                有効 (スケジューラで自動実行)
              </label>
            </div>

            <div className="settings-field" style={{ display: 'flex', gap: 24 }}>
              <div>
                <label htmlFor="f-maxturns" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>最大ターン数</label>
                <input
                  id="f-maxturns"
                  className="param-input"
                  data-testid="agent-jobs-maxturns"
                  type="number"
                  min={1} max={50}
                  value={draft.maxTurns}
                  disabled={readonly}
                  onChange={(e) => update('maxTurns', Number(e.target.value))}
                  style={{ width: 80 }}
                />
              </div>
              <div>
                <label htmlFor="f-timeout" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>タイムアウト (秒)</label>
                <input
                  id="f-timeout"
                  className="param-input"
                  data-testid="agent-jobs-timeout"
                  type="number"
                  min={10} max={600}
                  value={draft.timeoutSec}
                  disabled={readonly}
                  onChange={(e) => update('timeoutSec', Number(e.target.value))}
                  style={{ width: 80 }}
                />
              </div>
            </div>

            {/* 最終実行情報 */}
            {selectedJobState != null && (
              <div style={{ background: 'var(--bg-panel)', borderRadius: 8, padding: '10px 14px', fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontWeight: 600, marginBottom: 2, color: 'var(--text)', fontSize: 13 }}>最終実行</span>
                <span>日時: {selectedJobState.lastRunAt ?? '未実行'}</span>
                <span>結果: {selectedJobState.lastResult ?? '—'}</span>
                {selectedJobState.lastError !== null && (
                  <span style={{ color: 'var(--danger, #e05263)' }}>エラー: {selectedJobState.lastError}</span>
                )}
              </div>
            )}

            {/* 即時実行の結果 */}
            {runStatus !== 'idle' && (
              <div style={{
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 12.5,
                background: runStatus === 'running' ? 'var(--bg-panel)' : runStatus === 'done' ? 'var(--accent-soft)' : 'var(--danger-soft, rgba(224,82,99,.08))',
              }}>
                {runStatus === 'running' && <span>実行中…</span>}
                {runResult !== null && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span>結果: {runResult.result} ({runResult.durationMs}ms)</span>
                    {runResult.error !== null && <span style={{ color: 'var(--danger, #e05263)' }}>{runResult.error}</span>}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="md-detail-footer">
            {!readonly && (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="agent-jobs-save"
                  disabled={!isDirty || saveStatus === 'saving'}
                  onClick={() => void save()}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid="agent-jobs-cancel"
                  disabled={!isDirty}
                  onClick={cancel}
                >
                  キャンセル
                </button>
              </>
            )}
            {selectedName !== '__new__' && (
              <button
                type="button"
                className="btn"
                data-testid="agent-jobs-run"
                disabled={runStatus === 'running' || isDirty}
                title={isDirty ? '保存してから実行してください' : '今すぐ実行'}
                onClick={() => void runNow()}
                style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}
              >
                <IconPlay />
                今すぐ実行
              </button>
            )}
            {!readonly && selectedName !== null && (
              <button
                type="button"
                className="btn btn-ghost danger"
                data-testid="agent-jobs-delete"
                onClick={() => void deleteJob()}
                title="ジョブを削除"
              >
                <IconTrash />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="md-detail md-detail-empty">
          <div className="md-empty-msg">左のリストからジョブを選択、または「＋」で新規作成</div>
        </div>
      )}
    </div>
  );
}
