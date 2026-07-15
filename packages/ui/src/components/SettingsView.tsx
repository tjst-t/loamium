/**
 * 統一設定ハブ (Sa10026-7 + Sa100c6-1)。
 *
 * - 左ナビ 2 グループ:
 *   【設定】全体 / エージェント / プライバシー (既存パネルそのまま)
 *   【コンテンツ】テンプレート / スマートフォルダ / スマートコマンド (master-detail 2 ペイン)
 * - 各タブは型付き設定 API 経由で編集・保存。
 * - apiKey は平文保存せず $ENV_VAR 参照 (apiKeyRef) として表示。
 * - LOAMIUM_MODE read-only / append-only では書込 UI を disabled + mode バナー表示。
 * - モデルはカスタム select 風コンボボックス (native datalist 使用禁止)。
 * - per-item 導線リンク (settings-link) は Sa100c6-1 で撤去。
 *
 * [AC-Sa10026-7-1] [AC-Sa10026-7-2] [AC-Sa10026-7-3]
 * [AC-Sa100c6-1-1] [AC-Sa100c6-1-2] [AC-Sa100c6-1-3]
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { api } from '../api.js';
import { TemplatesPanel } from './TemplatesPanel.js';
import { SmartFoldersPanel } from './SmartFoldersPanel.js';
import { CommandsPanel } from './CommandsPanel.js';
import type {
  AppSettings,
  AgentConnectionResponse,
  AgentPermissionsResponse,
  AgentPrivacySettingsResponse,
  AgentConnectionTestResponse,
  AgentModelsResponse,
} from '@loamium/shared';

// ---- 型 ----

type SettingsGroup = 'general' | 'agent' | 'privacy' | 'templates' | 'smart-folders' | 'commands';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SettingsViewProps {
  /** read-only / append-only モードか (App が GET /api/health 結果を渡す) */
  mode: 'full' | 'append-only' | 'read-only';
  onClose: () => void;
  /**
   * 全体設定 (defaultFolder 等) の保存成功後に呼ぶ (Sa10026-9 #7)。
   * App 側で defaultFolder を再取得し、同一セッションの新規ノートに即反映するため。
   */
  onSaved?: () => void;
}

// ---- アイコン (SVG) ----

function IconGeneral(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M2.5 6.5h11" />
    </svg>
  );
}

function IconAgent(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="3" y="4.5" width="10" height="8" rx="2" />
      <path d="M8 4.5V2.5M6 8.5h.01M10 8.5h.01" />
    </svg>
  );
}

function IconPrivacy(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" />
    </svg>
  );
}

function IconCheck(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function IconWarn(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M8 1.5l6 11H2z" />
      <path d="M8 6.5v3M8 11h.01" />
    </svg>
  );
}

function IconClose(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function IconChevronDown(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function IconTemplate(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5 6h6M5 8.5h6M5 11h3.5" />
    </svg>
  );
}

function IconSmartFolder(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M2.5 5.5l1-2h3l1 1.5h5v6a1.5 1.5 0 01-1.5 1.5h-8A1.5 1.5 0 011 11z" />
    </svg>
  );
}

function IconCommand(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M4 5l2.5 3L4 11M8.5 11h3.5" />
    </svg>
  );
}

// ---- Switch (toggle) ----

function Switch({
  checked,
  onChange,
  disabled,
  testName,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
  testName: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-testid="settings-field"
      data-name={testName}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  );
}

// ---- ModelCombobox ----

function ModelCombobox({
  value,
  onChange,
  options,
  disabled,
  forceOpen,
  onForceOpenConsumed,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  disabled: boolean;
  /** 外部から開く指示 (モデル一覧取得後に自動オープン) */
  forceOpen?: boolean;
  onForceOpenConsumed?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 外部から開く指示を受けた場合
  useEffect(() => {
    if (forceOpen === true && options.length > 0) {
      setOpen(true);
      onForceOpenConsumed?.();
    }
  }, [forceOpen, options.length, onForceOpenConsumed]);

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return (
    <div
      className={`combobox${open ? ' open' : ''}`}
      data-testid="settings-model-combobox"
      ref={ref}
    >
      <input
        type="text"
        id="f-model"
        data-testid="settings-field"
        data-name="model"
        value={value}
        disabled={disabled}
        placeholder="モデル ID(直接入力可)"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="combo-toggle"
        data-testid="settings-model-toggle"
        aria-label="モデル候補を表示"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <IconChevronDown />
      </button>
      <ul
        className="combo-menu"
        data-testid="settings-model-options"
        role="listbox"
      >
        {options.map((m) => (
          <li
            key={m}
            role="option"
            tabIndex={-1}
            className={m === value ? 'sel' : ''}
            onClick={() => {
              onChange(m);
              setOpen(false);
            }}
          >
            {m}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- ConnResult ----

type ConnState = 'idle' | 'testing' | 'ok' | 'error';

function ConnResult({
  state,
  message,
}: {
  state: ConnState;
  message: string;
}): JSX.Element {
  if (state === 'idle') return <></>;
  return (
    <p
      className="conn-result"
      data-testid="settings-conn-result"
      data-state={state}
    >
      {state === 'testing' && (
        <>
          <span className="spinner" />
          {' '}接続を確認中…
        </>
      )}
      {state === 'ok' && (
        <>
          <IconCheck />
          {' '}{message}
        </>
      )}
      {state === 'error' && (
        <>
          <IconWarn />
          {' '}{message}
        </>
      )}
    </p>
  );
}

// ---- SaveStatusBadge (module-scope: avoid re-creating type on each render) ----

function SaveStatusBadge({ status, error }: { status: SaveStatus; error: string | null }): JSX.Element {
  if (status === 'idle') {
    return (
      <span className="settings-status" data-testid="settings-status" data-state="idle">
        <IconCheck />
      </span>
    );
  }
  if (status === 'saving') {
    return (
      <span className="settings-status" data-testid="settings-status" data-state="saving">
        保存中…
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="settings-status" data-testid="settings-status" data-state="saved">
        <IconCheck />
        保存済み
      </span>
    );
  }
  return (
    <span className="settings-status" data-testid="settings-status" data-state="error" style={{ color: 'var(--danger)' }}>
      {error ?? '保存に失敗しました'}
    </span>
  );
}

// ---- SettingsView (main) ----

export function SettingsView({ mode, onClose, onSaved }: SettingsViewProps): JSX.Element {
  const readonly = mode === 'read-only' || mode === 'append-only';

  const [activeGroup, setActiveGroup] = useState<SettingsGroup>('general');

  // ---- 全体設定 ----
  const [generalSettings, setGeneralSettings] = useState<AppSettings>({
    theme: 'system',
    defaultFolder: '',
    journalTemplate: 'system/templates/journal.md',
    showSystemFolder: false,
  });
  const [generalDraft, setGeneralDraft] = useState<AppSettings>(generalSettings);
  const [generalStatus, setGeneralStatus] = useState<SaveStatus>('idle');
  const [generalError, setGeneralError] = useState<string | null>(null);

  // ---- エージェント接続 ----
  const [connection, setConnection] = useState<AgentConnectionResponse['connection']>(null);
  const [connDraft, setConnDraft] = useState<{
    api: 'openai' | 'anthropic';
    baseUrl: string;
    model: string;
    apiKeyRef: string;
  }>({ api: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', apiKeyRef: '$ANTHROPIC_API_KEY' });
  /**
   * ユーザーが API キーフィールドを実際に編集したかを追跡する。
   * false = 保存済みキーを表示中 (PUT 時に apiKey を送らない = 既存キー維持)。
   * true  = ユーザーが新しい値を入力した (PUT 時に apiKey を送る)。
   */
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [permissions, setPermissions] = useState<AgentPermissionsResponse['permissions']>(null);
  const [permDraft, setPermDraft] = useState<{
    mode: string;
    capWrite: boolean;
    capWeb: boolean;
  }>({ mode: 'full', capWrite: true, capWeb: false });
  const [agentStatus, setAgentStatus] = useState<SaveStatus>('idle');
  const [agentError, setAgentError] = useState<string | null>(null);

  // 接続テスト
  const [connState, setConnState] = useState<ConnState>('idle');
  const [connMessage, setConnMessage] = useState('');

  // モデル候補
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelComboForceOpen, setModelComboForceOpen] = useState(false);

  // ---- プライバシー ----
  const [deny, setDeny] = useState<string[]>([]);
  const [denyInput, setDenyInput] = useState('');
  const [privacyStatus, setPrivacyStatus] = useState<SaveStatus>('idle');
  const [privacyError, setPrivacyError] = useState<string | null>(null);

  // ---- 初期ロード ----
  const generalLoadedRef = useRef(false);
  const agentLoadedRef = useRef(false);
  const privacyLoadedRef = useRef(false);

  const loadGeneral = useCallback(async (): Promise<void> => {
    if (generalLoadedRef.current) return;
    generalLoadedRef.current = true;
    try {
      const s = await api.getSystemSettings();
      setGeneralSettings(s);
      setGeneralDraft(s);
    } catch {
      // graceful degradation: keep defaults
    }
  }, []);

  const loadAgent = useCallback(async (): Promise<void> => {
    if (agentLoadedRef.current) return;
    agentLoadedRef.current = true;
    try {
      const [connRes, permRes] = await Promise.all([
        api.getAgentConnection(),
        api.getAgentPermissions(),
      ]);
      setConnection(connRes.connection);
      if (connRes.connection !== null) {
        setConnDraft({
          api: connRes.connection.api,
          baseUrl: connRes.connection.baseUrl,
          model: connRes.connection.model,
          apiKeyRef: connRes.connection.apiKeyRef,
        });
        // 既存キーがある場合はフォームを「未変更」として初期化
        setApiKeyDirty(false);
      }
      setPermissions(permRes.permissions);
      if (permRes.permissions !== null) {
        const eff = permRes.permissions.effective;
        // effective は AGENT_CAPABILITIES の文字列 ('note_edit', 'note_create', 'web' 等)
        const rawValue = permRes.permissions.value;
        const validPresets = ['read-only', 'notes-rw', 'full'] as const;
        const preset = validPresets.includes(rawValue as typeof validPresets[number])
          ? (rawValue as typeof validPresets[number])
          : 'full';
        setPermDraft({
          mode: preset,
          capWrite: eff.includes('note_edit') || eff.includes('note_create'),
          capWeb: eff.includes('web'),
        });
      }
    } catch {
      // keep defaults
    }
  }, []);

  const loadPrivacy = useCallback(async (): Promise<void> => {
    if (privacyLoadedRef.current) return;
    privacyLoadedRef.current = true;
    try {
      const res = await api.getAgentPrivacy();
      setDeny(res.deny);
    } catch {
      setDeny([]);
    }
  }, []);

  // タブ切替時のロード
  useEffect(() => {
    void loadGeneral();
  }, [loadGeneral]);

  const switchGroup = useCallback((g: SettingsGroup): void => {
    setActiveGroup(g);
    if (g === 'agent') void loadAgent();
    if (g === 'privacy') void loadPrivacy();
    // コンテンツ系 (templates/smart-folders/commands) は各パネルが自分でロードする
  }, [loadAgent, loadPrivacy]);

  // ---- 全体: 保存 ----
  const saveGeneral = useCallback(async (): Promise<void> => {
    setGeneralStatus('saving');
    setGeneralError(null);
    try {
      await api.putSystemSettings(generalDraft);
      setGeneralSettings(generalDraft);
      setGeneralStatus('saved');
      setTimeout(() => setGeneralStatus('idle'), 2000);
      // Sa10026-9 #7: 保存成功を App へ通知し defaultFolder 等を再取得させる
      onSaved?.();
    } catch (err) {
      setGeneralStatus('error');
      setGeneralError(err instanceof Error ? err.message : String(err));
    }
  }, [generalDraft, onSaved]);

  const resetGeneral = useCallback((): void => {
    setGeneralDraft(generalSettings);
    setGeneralStatus('idle');
    setGeneralError(null);
  }, [generalSettings]);

  // ---- エージェント: 保存 ----
  const saveAgent = useCallback(async (): Promise<void> => {
    setAgentStatus('saving');
    setAgentError(null);
    try {
      await Promise.all([
        api.putAgentConnection({
          api: connDraft.api,
          baseUrl: connDraft.baseUrl,
          model: connDraft.model,
          // apiKeyDirty=false のときは apiKey を送らない (既存キーを維持)
          // apiKeyDirty=true のときはフォームの現在値を送る
          ...(apiKeyDirty ? { apiKey: connDraft.apiKeyRef } : {}),
        }),
        // permissions は capability 配列で渡す (preset 名 or 配列 — agentPermissionsSchema 準拠)
        // capWrite = note_edit + note_create, capWeb = web (ADR-0017 opt-in)
        api.putAgentPermissions(
          permDraft.mode === 'full'
            ? 'full'
            : permDraft.mode === 'read-only'
            ? 'read-only'
            : permDraft.mode === 'notes-rw'
            ? 'notes-rw'
            : [
                'read',
                ...(permDraft.capWrite ? (['note_create', 'note_edit', 'journal_append'] as const) : []),
                ...(permDraft.capWeb ? (['web'] as const) : []),
              ],
        ),
      ]);
      setAgentStatus('saved');
      setApiKeyDirty(false); // 保存成功 → 次回保存は変更があった場合のみ送る
      setTimeout(() => setAgentStatus('idle'), 2000);
    } catch (err) {
      setAgentStatus('error');
      setAgentError(err instanceof Error ? err.message : String(err));
    }
  }, [connDraft, permDraft, apiKeyDirty]);

  const resetAgent = useCallback((): void => {
    if (connection !== null) {
      setConnDraft({
        api: connection.api,
        baseUrl: connection.baseUrl,
        model: connection.model,
        apiKeyRef: connection.apiKeyRef,
      });
      setApiKeyDirty(false); // リセット時もキーは未変更に戻す
    }
    if (permissions !== null) {
      const eff = permissions.effective;
      const validPresets = ['read-only', 'notes-rw', 'full'] as const;
      const preset = validPresets.includes(permissions.value as typeof validPresets[number])
        ? (permissions.value as typeof validPresets[number])
        : 'full';
      setPermDraft({
        mode: preset,
        capWrite: eff.includes('note_edit') || eff.includes('note_create'),
        capWeb: eff.includes('web'),
      });
    }
    setAgentStatus('idle');
    setAgentError(null);
  }, [connection, permissions]);

  // ---- 接続テスト ----
  const testConn = useCallback(async (): Promise<void> => {
    setConnState('testing');
    setConnMessage('');
    try {
      // モデルは送らない (接続テストは /models エンドポイントで疎通確認)
      const res: AgentConnectionTestResponse = await api.testAgentConnection({
        baseUrl: connDraft.baseUrl,
        api: connDraft.api,
        apiKeyRef: connDraft.apiKeyRef,
      });
      if (res.ok) {
        const latency = res.latencyMs !== undefined ? `(${String(res.latencyMs)}ms)` : '';
        const modelCount = res.models !== undefined ? res.models.length : 0;
        setConnState('ok');
        setConnMessage(
          modelCount > 0
            ? `接続成功 — ${String(modelCount)} 件のモデルを取得${latency}`
            : `接続成功${latency}`,
        );
        // テスト成功 → 返ってきたモデル一覧でドロップダウンを populate
        if (res.models !== undefined && res.models.length > 0) {
          setModelOptions(res.models);
          setModelComboForceOpen(true);
        }
      } else {
        setConnState('error');
        setConnMessage(res.error ?? '接続に失敗しました');
      }
    } catch (err) {
      setConnState('error');
      setConnMessage(err instanceof Error ? err.message : String(err));
    }
  }, [connDraft]);

  // ---- モデル一覧取得 ----
  const loadModels = useCallback(async (): Promise<void> => {
    setModelsLoading(true);
    try {
      const res: AgentModelsResponse = await api.getAgentModels();
      setModelOptions(res.models);
      if (res.models.length > 0) {
        setModelComboForceOpen(true);
      }
      setConnState('ok');
      setConnMessage(`${String(res.models.length)} 件のモデルを取得しました`);
    } catch {
      // models list fetch failure is non-fatal; direct input still works
    } finally {
      setModelsLoading(false);
    }
  }, []);

  // ---- プライバシー: 保存 ----
  const savePrivacy = useCallback(async (): Promise<void> => {
    setPrivacyStatus('saving');
    setPrivacyError(null);
    try {
      await api.putAgentPrivacy(deny);
      setPrivacyStatus('saved');
      setTimeout(() => setPrivacyStatus('idle'), 2000);
    } catch (err) {
      setPrivacyStatus('error');
      setPrivacyError(err instanceof Error ? err.message : String(err));
    }
  }, [deny]);

  const addDenyEntry = useCallback((): void => {
    const v = denyInput.trim();
    if (v === '' || deny.includes(v)) return;
    setDeny((prev) => [...prev, v]);
    setDenyInput('');
  }, [denyInput, deny]);

  const removeDenyEntry = useCallback((entry: string): void => {
    setDeny((prev) => prev.filter((e) => e !== entry));
  }, []);

  const currentStatus = activeGroup === 'general' ? generalStatus
    : activeGroup === 'agent' ? agentStatus
    : activeGroup === 'privacy' ? privacyStatus
    : 'idle'; // コンテンツグループは各パネルが独自ステータスを持つ
  const currentError = activeGroup === 'general' ? generalError
    : activeGroup === 'agent' ? agentError
    : activeGroup === 'privacy' ? privacyError
    : null;

  // コンテンツグループ (master-detail) かどうか
  const isContentGroup = activeGroup === 'templates' || activeGroup === 'smart-folders' || activeGroup === 'commands';

  const mainClass = `settings-main${readonly ? ' readonly' : ''}${isContentGroup ? ' settings-main-md' : ''}`;

  return (
    <div className="settings-view" data-testid="settings-view" role="region" aria-label="設定">
      {/* 左ナビ: 2グループ (設定/コンテンツ) — AC-Sa100c6-1-1 */}
      <nav className="settings-nav" data-testid="settings-nav" aria-label="設定カテゴリ">
        <div className="nav-title">設定</div>

        <button
          type="button"
          className={`nav-item${activeGroup === 'general' ? ' active' : ''}`}
          data-testid="settings-nav-item"
          data-group="general"
          onClick={() => switchGroup('general')}
        >
          <IconGeneral />
          全体
        </button>
        <button
          type="button"
          className={`nav-item${activeGroup === 'agent' ? ' active' : ''}`}
          data-testid="settings-nav-item"
          data-group="agent"
          onClick={() => switchGroup('agent')}
        >
          <IconAgent />
          エージェント
        </button>
        <button
          type="button"
          className={`nav-item${activeGroup === 'privacy' ? ' active' : ''}`}
          data-testid="settings-nav-item"
          data-group="privacy"
          onClick={() => switchGroup('privacy')}
        >
          <IconPrivacy />
          プライバシー
        </button>

        <div className="nav-sep" />
        <div className="nav-title">コンテンツ</div>

        {/* AC-Sa100c6-1-1: コンテンツ系 (master-detail)。settings-link は撤去。 */}
        <button
          type="button"
          className={`nav-item${activeGroup === 'templates' ? ' active' : ''}`}
          data-testid="settings-nav-item"
          data-group="templates"
          onClick={() => switchGroup('templates')}
        >
          <IconTemplate />
          テンプレート
        </button>
        <button
          type="button"
          className={`nav-item${activeGroup === 'smart-folders' ? ' active' : ''}`}
          data-testid="settings-nav-item"
          data-group="smart-folders"
          onClick={() => switchGroup('smart-folders')}
        >
          <IconSmartFolder />
          スマートフォルダ
        </button>
        <button
          type="button"
          className={`nav-item${activeGroup === 'commands' ? ' active' : ''}`}
          data-testid="settings-nav-item"
          data-group="commands"
          onClick={() => switchGroup('commands')}
        >
          <IconCommand />
          スマートコマンド
        </button>
      </nav>

      {/* 右: パネル or master-detail */}
      {isContentGroup ? (
        /* ============ コンテンツグループ: master-detail 2 ペイン ============ */
        <div className="settings-main settings-main-md" id="settingsMain">
          {/* テンプレート */}
          {activeGroup === 'templates' && (
            <TemplatesPanel mode={mode} />
          )}
          {/* スマートフォルダ — Sa100c6-2 */}
          {activeGroup === 'smart-folders' && (
            <SmartFoldersPanel mode={mode} />
          )}
          {/* スマートコマンド — Sa100c6-3 */}
          {activeGroup === 'commands' && (
            <CommandsPanel mode={mode} />
          )}
        </div>
      ) : (
      /* ============ 設定グループ: 既存シングルフォームパネル ============ */
      <div className={mainClass} id="settingsMain">
        <div className="settings-head">
          <h1 id="panelTitle">
            {activeGroup === 'general' ? '全体'
              : activeGroup === 'agent' ? 'エージェント'
              : 'プライバシー'}
          </h1>
          <SaveStatusBadge status={currentStatus} error={currentError} />
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="設定を閉じる"
            style={{ marginLeft: 8 }}
          >
            <IconClose />
          </button>
        </div>
        <p className="settings-sub">
          {activeGroup === 'general'
            ? <>アプリ全体設定 — <code>system/settings.yaml</code>(vault のファイル・agent 編集可)</>
            : activeGroup === 'agent'
            ? <>エージェント接続・権限 — <code>.loamium/agent-*.json</code>(型付き設定 API 経由・agent 編集不可)</>
            : <>agent 機密領域 — <code>.loamium/agent-privacy.json</code>(agent 編集不可)</>}
        </p>

        {/* AC-Sa10026-7-3: read-only バナー */}
        {readonly && (
          <div className="mode-banner" data-testid="mode-banner">
            <IconWarn />
            {mode === 'read-only'
              ? <>read-only モード: 設定は変更できません(<code>LOAMIUM_MODE</code>)</>
              : <>append-only モード: 設定は変更できません(<code>LOAMIUM_MODE</code>)</>}
          </div>
        )}

        {/* ============ 全体タブ ============ */}
        <section
          className={`settings-panel${activeGroup === 'general' ? ' active' : ''}`}
          data-testid="settings-panel"
          data-group="general"
        >
          <div className="field-group">
            <h2>表示</h2>
            <div className="settings-field">
              <label htmlFor="f-theme">テーマ</label>
              <select
                id="f-theme"
                data-testid="settings-field"
                data-name="theme"
                disabled={readonly}
                value={generalDraft.theme}
                onChange={(e) =>
                  setGeneralDraft((d) => ({ ...d, theme: e.target.value as AppSettings['theme'] }))
                }
              >
                <option value="light">ライト</option>
                <option value="dark">ダーク</option>
                <option value="system">システムに合わせる</option>
              </select>
            </div>
            <div className="settings-field">
              <div className="toggle-row">
                <div className="toggle-label">
                  <label>設定フォルダ(<code>system/</code>)をツリーに表示</label>
                  <p className="hint">OFF(既定)ではサイドバーに設定フォルダ system/ を表示しません。ファイルは vault 内に存在します。</p>
                </div>
                <Switch
                  checked={generalDraft.showSystemFolder}
                  onChange={(v) => setGeneralDraft((d) => ({ ...d, showSystemFolder: v }))}
                  disabled={readonly}
                  testName="showSystemFolder"
                />
              </div>
            </div>
          </div>
          <div className="field-group">
            <h2>既定</h2>
            <div className="settings-field">
              <label htmlFor="f-folder">新規ノートの既定フォルダ</label>
              <input
                type="text"
                id="f-folder"
                data-testid="settings-field"
                data-name="defaultFolder"
                disabled={readonly}
                value={generalDraft.defaultFolder}
                onChange={(e) =>
                  setGeneralDraft((d) => ({ ...d, defaultFolder: e.target.value }))
                }
              />
              <p className="hint">新規ノート作成モーダルにこのフォルダを prefill します。空なら vault 直下。</p>
            </div>
            <div className="settings-field">
              <label htmlFor="f-jtmpl">ジャーナルテンプレート</label>
              <input
                type="text"
                id="f-jtmpl"
                data-testid="settings-field"
                data-name="journalTemplate"
                disabled={readonly}
                value={generalDraft.journalTemplate}
                onChange={(e) =>
                  setGeneralDraft((d) => ({ ...d, journalTemplate: e.target.value }))
                }
              />
              <p className="hint">空なら空ファイルで生成。</p>
            </div>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="settings-save"
              data-group="general"
              disabled={readonly || generalStatus === 'saving'}
              onClick={() => void saveGeneral()}
            >
              保存
            </button>
            <button
              type="button"
              className="btn"
              data-testid="settings-reset"
              data-group="general"
              disabled={readonly}
              onClick={resetGeneral}
            >
              元に戻す
            </button>
          </div>
        </section>

        {/* ============ エージェントタブ ============ */}
        <section
          className={`settings-panel${activeGroup === 'agent' ? ' active' : ''}`}
          data-testid="settings-panel"
          data-group="agent"
        >
          <div className="field-group">
            <h2>接続</h2>
            {/* 並び順: API種別 → baseUrl → APIキー(右に接続テストボタン) → モデル */}
            <div className="settings-field">
              <label htmlFor="f-apitype">API 種別</label>
              <select
                id="f-apitype"
                data-testid="settings-field"
                data-name="apiType"
                disabled={readonly}
                value={connDraft.api}
                onChange={(e) =>
                  setConnDraft((d) => ({ ...d, api: e.target.value as 'openai' | 'anthropic' }))
                }
              >
                <option value="anthropic">anthropic</option>
                <option value="openai">openai 互換</option>
              </select>
            </div>
            <div className="settings-field">
              <label htmlFor="f-baseurl">baseUrl</label>
              <input
                type="text"
                id="f-baseurl"
                data-testid="settings-field"
                data-name="baseUrl"
                disabled={readonly}
                value={connDraft.baseUrl}
                onChange={(e) =>
                  setConnDraft((d) => ({ ...d, baseUrl: e.target.value }))
                }
              />
            </div>
            <div className="settings-field">
              <label htmlFor="f-key">API キー</label>
              <div className="env-field">
                {/*
                  直値 (sk-... 等) を直接入力できる。$ENV_VAR 形式での環境変数参照も可。
                  apiKeyDirty=false のときは保存済みキーのプレースホルダを表示し、
                  ユーザーが入力し始めたら dirty フラグを立てる。
                */}
                <input
                  type="text"
                  id="f-key"
                  data-testid="settings-field"
                  data-name="apiKeyEnv"
                  disabled={readonly}
                  value={apiKeyDirty ? connDraft.apiKeyRef : ''}
                  placeholder={
                    !apiKeyDirty
                      ? (connection?.hasApiKey === true
                          ? (connDraft.apiKeyRef.startsWith('$')
                              ? connDraft.apiKeyRef
                              : '保存済み')
                          : 'sk-... または $ENV_VAR')
                      : undefined
                  }
                  onChange={(e) => {
                    setApiKeyDirty(true);
                    setConnDraft((d) => ({ ...d, apiKeyRef: e.target.value }));
                  }}
                  onFocus={() => {
                    // フォーカス時に既存値をフィールドにコピーして編集しやすくする
                    // (ただし実値は取れないため $ENV_VAR の場合のみコピー)
                    if (!apiKeyDirty && connDraft.apiKeyRef.startsWith('$')) {
                      setApiKeyDirty(true);
                    }
                  }}
                />
                {!apiKeyDirty && connDraft.apiKeyRef.startsWith('$') && (
                  <span className="env-badge">$ENV 参照</span>
                )}
                <button
                  type="button"
                  className="btn conn-test"
                  data-testid="settings-conn-test"
                  disabled={readonly}
                  onClick={() => void testConn()}
                >
                  接続テスト
                </button>
              </div>
              <ConnResult state={connState} message={connMessage} />
              <p className="hint">
                API キーを直接入力できます(<code>$ENV_VAR</code> 形式で環境変数名を指定することも可能)。
                キーは <code>.loamium/</code>(ローカル・git 管理外)に保存されます。
              </p>
            </div>
            <div className="settings-field">
              <label>モデル</label>
              <div className="model-row">
                <ModelCombobox
                  value={connDraft.model}
                  onChange={(v) => setConnDraft((d) => ({ ...d, model: v }))}
                  options={modelOptions}
                  disabled={readonly}
                  forceOpen={modelComboForceOpen}
                  onForceOpenConsumed={() => setModelComboForceOpen(false)}
                />
                <button
                  type="button"
                  className="btn"
                  data-testid="settings-model-refresh"
                  disabled={readonly || modelsLoading}
                  onClick={() => void loadModels()}
                >
                  一覧取得
                </button>
              </div>
              <p className="hint">接続先 API から取得した候補をドロップダウン表示。一覧に無い ID の直接入力も可能。</p>
            </div>
          </div>
          <div className="field-group">
            <h2>
              権限{' '}
              <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-faint)' }}>
                — agent 自身は変更不可(自己昇格防止 / Sa10026-6)
              </span>
            </h2>
            <div className="settings-field">
              <label htmlFor="f-mode">実行モード</label>
              <select
                id="f-mode"
                data-testid="settings-field"
                data-name="mode"
                disabled={readonly}
                value={permDraft.mode}
                onChange={(e) => setPermDraft((d) => ({ ...d, mode: e.target.value }))}
              >
                {/* AGENT_PRESET_NAMES: 'read-only' | 'notes-rw' | 'full' */}
                <option value="full">full(全ケーパビリティ)</option>
                <option value="notes-rw">notes-rw(ノート読み書き)</option>
                <option value="read-only">read-only(読み取りのみ)</option>
              </select>
            </div>
            <div className="settings-field">
              <div className="toggle-row">
                <div className="toggle-label">
                  <label>書き込みツールを許可</label>
                </div>
                <Switch
                  checked={permDraft.capWrite}
                  onChange={(v) => setPermDraft((d) => ({ ...d, capWrite: v }))}
                  disabled={readonly}
                  testName="cap.write"
                />
              </div>
            </div>
            <div className="settings-field">
              <div className="toggle-row">
                <div className="toggle-label">
                  <label>Web アクセスを許可</label>
                  <p className="hint">漏洩面が最大。既定は OFF(ADR-0017 opt-in)。</p>
                </div>
                <Switch
                  checked={permDraft.capWeb}
                  onChange={(v) => setPermDraft((d) => ({ ...d, capWeb: v }))}
                  disabled={readonly}
                  testName="cap.web"
                />
              </div>
            </div>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="settings-save"
              data-group="agent"
              disabled={readonly || agentStatus === 'saving'}
              onClick={() => void saveAgent()}
            >
              保存
            </button>
            <button
              type="button"
              className="btn"
              data-testid="settings-reset"
              data-group="agent"
              disabled={readonly}
              onClick={resetAgent}
            >
              元に戻す
            </button>
          </div>
        </section>

        {/* ============ プライバシータブ ============ */}
        <section
          className={`settings-panel${activeGroup === 'privacy' ? ' active' : ''}`}
          data-testid="settings-panel"
          data-group="privacy"
        >
          <div className="field-group">
            <h2>agent 機密領域 deny-list</h2>
            <p className="hint" style={{ margin: '-4px 0 12px' }}>
              ここに一致するパスは agent から読めません(ADR-0018)。agent 自身は編集できません。
            </p>
            <div className="deny-list" data-testid="deny-list">
              {deny.map((entry) => (
                <div
                  key={entry}
                  className="deny-entry"
                  data-testid="deny-entry"
                  data-value={entry}
                >
                  <span className="path">{entry}</span>
                  <button
                    type="button"
                    className="del"
                    data-testid="deny-del"
                    title="削除"
                    disabled={readonly}
                    onClick={() => removeDenyEntry(entry)}
                  >
                    <IconClose />
                  </button>
                </div>
              ))}
            </div>
            <div className="deny-add-row">
              <input
                type="text"
                data-testid="deny-add-input"
                placeholder="例: finances/**"
                disabled={readonly}
                value={denyInput}
                onChange={(e) => setDenyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addDenyEntry();
                }}
              />
              <button
                type="button"
                className="btn"
                data-testid="deny-add"
                disabled={readonly || denyInput.trim() === ''}
                onClick={addDenyEntry}
              >
                追加
              </button>
            </div>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="settings-save"
              data-group="privacy"
              disabled={readonly || privacyStatus === 'saving'}
              onClick={() => void savePrivacy()}
            >
              保存
            </button>
          </div>
        </section>
      </div>
      )} {/* end ternary isContentGroup */}
    </div>
  );
}
