/**
 * スマートコマンド管理 master-detail パネル (Sa100c6-3)。
 *
 * - 左ペイン: コマンド一覧 (絞り込み) + 新規ボタン
 * - 右ペイン: 名前(編集可能タイトルヘッダ) + 説明 + パラメータ一覧 + ステップ一覧
 *   - 各 param/step 行に編集ボタン(鉛筆)+ 削除(×)。確定済みも後から編集可能。
 *   - ＋パラメータ/＋ステップ追加。
 *   - フッタ: 保存 / キャンセル / 試し実行 / 削除。
 * - 保存: LoamiumCommand → YAML 文字列 → PUT /api/commands/{id}/source
 * - 削除: DELETE /api/system-files/system/commands/{id}.yaml/source
 * - 試し実行: POST /api/commands/{id}/run (既存 TestRunParamForm 再利用)
 * - read-only モードでは書込 UI disabled。
 * - agent 非公開 + 監査ログはサーバー側で保証。
 *
 * [AC-Sa100c6-3-1] [AC-Sa100c6-3-2]
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type JSX,
} from 'react';
import { api } from '../api.js';
import type {
  CommandSummary,
  CommandParam,
  CommandStep,
  LoamiumCommand,
  CommandRunResponse,
} from '@loamium/shared';
import {
  parseLoamiumCommandFileWithError,
} from '@loamium/shared';

// ---- 型 ----

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface CommandsPanelProps {
  mode: 'full' | 'append-only' | 'read-only';
}

/** 編集中コマンドの draft 状態 */
interface CommandDraft {
  /** stem (ファイル名拡張子なし) = 安定識別子 */
  id: string;
  name: string;
  description: string;
  params: CommandParam[];
  steps: CommandStep[];
  /** コマンドの YAML 生テキスト (ロード済み) */
  yamlSource: string;
  mtime: number | null;
}

/** ステップ種別 */
type StepKind =
  | 'journal-append'
  | 'note-append'
  | 'note-create'
  | 'template-instantiate'
  | 'prop-set'
  | 'note-patch'
  | 'agent-run';

const STEP_KINDS: StepKind[] = [
  'journal-append',
  'note-append',
  'note-create',
  'template-instantiate',
  'prop-set',
  'note-patch',
  'agent-run',
];

// ---- YAML シリアライザ ----
// (yaml パッケージは @loamium/shared 経由で使用可能だが、UI パッケージの直接依存として
//  stringify を取り込むためにここでシンプルなシリアライザを実装する)

function yamlString(s: string): string {
  // 複数行 or 特殊文字を含む場合はブロックスカラー or クォート
  if (s.includes('\n')) {
    const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    // ブロックリテラル形式
    return `|-\n    ${s.split('\n').join('\n    ')}`;
  }
  // 特殊文字チェック: : { } [ ] , & * # ? | - < > = ! % @ ` \n \r \t
  if (/[:{}[\],&*#?|<>=!%@`]/.test(s) || s.startsWith('"') || s.trim() !== s || s === '' || s === 'true' || s === 'false' || s === 'null' || /^\d/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function paramToYaml(p: CommandParam, indent: string): string {
  const lines: string[] = [`${indent}- name: ${yamlString(p.name)}`];
  if (p.label !== undefined) lines.push(`${indent}  label: ${yamlString(p.label)}`);
  if (p.type !== undefined) lines.push(`${indent}  type: ${p.type}`);
  if (p.required === true) lines.push(`${indent}  required: true`);
  if (p.default !== undefined) lines.push(`${indent}  default: ${yamlString(p.default)}`);
  if (p.options !== undefined && p.options.length > 0) {
    lines.push(`${indent}  options:`);
    for (const opt of p.options) lines.push(`${indent}    - ${yamlString(opt)}`);
  }
  return lines.join('\n');
}

function stepToYaml(step: CommandStep, indent: string): string {
  const lines: string[] = [`${indent}- kind: ${step.kind}`];
  const s = step as Record<string, unknown>;

  const skipKeys = new Set(['kind', 'when', 'when-not']);
  for (const [k, v] of Object.entries(s)) {
    if (skipKeys.has(k)) continue;
    if (v === undefined) continue;
    if (typeof v === 'string') {
      const serialized = paramToYaml({ name: '' }, '').trim(); // dummy
      // Use block scalar for multiline
      if (v.includes('\n')) {
        lines.push(`${indent}  ${k}: |-`);
        for (const line of v.split('\n')) lines.push(`${indent}    ${line}`);
      } else {
        lines.push(`${indent}  ${k}: ${yamlString(v)}`);
      }
    } else if (typeof v === 'boolean') {
      lines.push(`${indent}  ${k}: ${v ? 'true' : 'false'}`);
    } else if (typeof v === 'number') {
      lines.push(`${indent}  ${k}: ${String(v)}`);
    } else if (Array.isArray(v)) {
      lines.push(`${indent}  ${k}:`);
      for (const item of v as string[]) lines.push(`${indent}    - ${yamlString(item)}`);
    } else if (typeof v === 'object' && v !== null) {
      lines.push(`${indent}  ${k}:`);
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof mv === 'string') lines.push(`${indent}    ${mk}: ${yamlString(mv)}`);
        else if (typeof mv === 'boolean') lines.push(`${indent}    ${mk}: ${mv ? 'true' : 'false'}`);
        else if (typeof mv === 'number') lines.push(`${indent}    ${mk}: ${String(mv)}`);
      }
    }
  }
  if (s['when'] !== undefined) lines.push(`${indent}  when: ${yamlString(String(s['when']))}`);
  if (s['when-not'] !== undefined) lines.push(`${indent}  when-not: ${yamlString(String(s['when-not']))}`);
  return lines.join('\n');
}

/** LoamiumCommand オブジェクトを YAML 文字列に変換する */
function commandToYaml(cmd: { name: string; description: string; params: CommandParam[]; steps: CommandStep[] }): string {
  const lines: string[] = [];
  if (cmd.name.trim() !== '') lines.push(`name: ${yamlString(cmd.name)}`);
  if (cmd.description.trim() !== '') lines.push(`description: ${yamlString(cmd.description)}`);
  if (cmd.params.length > 0) {
    lines.push('params:');
    for (const p of cmd.params) lines.push(paramToYaml(p, ''));
  }
  lines.push('steps:');
  for (const s of cmd.steps) lines.push(stepToYaml(s, ''));
  return lines.join('\n') + '\n';
}

// ---- テスト実行 (RunState) ----

type RunPhase =
  | { phase: 'idle' }
  | { phase: 'param-form' }
  | { phase: 'running' }
  | { phase: 'done'; result: CommandRunResponse }
  | { phase: 'error'; message: string };

// ---- パラメータ編集モーダル ----

interface ParamEditModalProps {
  initial: CommandParam | null; // null = 新規
  onSave: (p: CommandParam) => void;
  onCancel: () => void;
  readonly: boolean;
}

function ParamEditModal({ initial, onSave, onCancel, readonly }: ParamEditModalProps): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [type, setType] = useState<CommandParam['type']>(initial?.type ?? 'string');
  const [required, setRequired] = useState(initial?.required ?? false);
  const [defaultVal, setDefaultVal] = useState(initial?.default ?? '');
  const [options, setOptions] = useState(initial?.options?.join('\n') ?? '');
  const [error, setError] = useState('');

  const handleSave = useCallback((): void => {
    if (name.trim() === '') { setError('パラメータ名は必須です'); return; }
    if (type === 'select' && options.trim() === '') { setError("select 型は options が必要です"); return; }
    const param: CommandParam = {
      name: name.trim(),
      ...(label.trim() !== '' && { label: label.trim() }),
      ...(type !== undefined && type !== 'string' && { type }),
      ...(type === 'string' && { type: 'string' }),
      ...(required && { required: true }),
      ...(defaultVal.trim() !== '' && { default: defaultVal.trim() }),
      ...(type === 'select' && options.trim() !== '' && {
        options: options.split('\n').map((o) => o.trim()).filter((o) => o !== ''),
      }),
    };
    onSave(param);
  }, [name, label, type, required, defaultVal, options, onSave]);

  return (
    <div
      className="param-form-backdrop"
      data-testid="param-edit-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="param-modal"
        data-testid="param-edit-modal"
        role="dialog"
        aria-label="パラメータを編集"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="param-modal-head">
          <h2 data-testid="param-edit-title">{initial === null ? 'パラメータを追加' : 'パラメータを編集'}</h2>
          <button className="icon-btn" data-testid="param-edit-close" title="閉じる" onClick={onCancel}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>
        <div className="param-fields">
          {error !== '' && (
            <div className="param-field-error" style={{ margin: '0 0 8px', padding: '6px 10px', background: 'var(--danger-soft, rgba(224,82,99,.08))', borderRadius: 6 }}>
              {error}
            </div>
          )}
          <div className="param-field-row" data-testid="param-edit-field" data-name="name">
            <label className="param-field-label">パラメータ名<span className="req">*</span></label>
            <input
              className="param-input"
              data-testid="param-edit-name"
              type="text"
              value={name}
              disabled={readonly}
              placeholder="例: task"
              onChange={(e) => { setName(e.target.value); setError(''); }}
            />
          </div>
          <div className="param-field-row" data-testid="param-edit-field" data-name="label">
            <label className="param-field-label">ラベル<span className="opt">任意</span></label>
            <input
              className="param-input"
              data-testid="param-edit-label"
              type="text"
              value={label}
              disabled={readonly}
              placeholder="例: タスク名"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="param-field-row" data-testid="param-edit-field" data-name="type">
            <label className="param-field-label">型</label>
            <select
              className="param-input"
              data-testid="param-edit-type"
              value={type ?? 'string'}
              disabled={readonly}
              onChange={(e) => setType(e.target.value as CommandParam['type'])}
            >
              <option value="string">string (1行テキスト)</option>
              <option value="text">text (複数行)</option>
              <option value="date">date (日付)</option>
              <option value="select">select (ドロップダウン)</option>
              <option value="note">note (ノートパス)</option>
              <option value="boolean">boolean (チェックボックス)</option>
              <option value="number">number (数値)</option>
            </select>
          </div>
          {type === 'select' && (
            <div className="param-field-row" data-testid="param-edit-field" data-name="options">
              <label className="param-field-label">選択肢 (1行1つ)<span className="req">*</span></label>
              <textarea
                className="param-input"
                data-testid="param-edit-options"
                rows={3}
                value={options}
                disabled={readonly}
                placeholder="選択肢A&#10;選択肢B&#10;選択肢C"
                onChange={(e) => setOptions(e.target.value)}
              />
            </div>
          )}
          <div className="param-field-row" data-testid="param-edit-field" data-name="default">
            <label className="param-field-label">既定値<span className="opt">任意</span></label>
            <input
              className="param-input"
              data-testid="param-edit-default"
              type="text"
              value={defaultVal}
              disabled={readonly}
              placeholder="省略時は空"
              onChange={(e) => setDefaultVal(e.target.value)}
            />
          </div>
          <div className="param-field-row" data-testid="param-edit-field" data-name="required">
            <label className="param-field-label">
              <input
                type="checkbox"
                data-testid="param-edit-required"
                checked={required}
                disabled={readonly}
                onChange={(e) => setRequired(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              必須
            </label>
          </div>
        </div>
        <div className="param-modal-foot">
          <div className="param-foot-actions">
            <button className="btn" data-testid="param-edit-cancel" onClick={onCancel}>キャンセル</button>
            <button className="btn primary" data-testid="param-edit-save" disabled={readonly} onClick={handleSave}>
              {initial === null ? '追加' : '更新'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- ステップ編集モーダル ----

/** kind ごとのデフォルト step */
function defaultStep(kind: StepKind): CommandStep {
  switch (kind) {
    case 'journal-append': return { kind: 'journal-append', content: '' };
    case 'note-append': return { kind: 'note-append', target: '', content: '' };
    case 'note-create': return { kind: 'note-create', target: '', content: '' };
    case 'template-instantiate': return { kind: 'template-instantiate', template: '' };
    case 'prop-set': return { kind: 'prop-set', target: '' };
    case 'note-patch': return { kind: 'note-patch', target: '', old: '', new: '' };
    case 'agent-run': return { kind: 'agent-run', prompt: '' };
  }
}

interface StepEditModalProps {
  initial: CommandStep | null; // null = 新規
  onSave: (s: CommandStep) => void;
  onCancel: () => void;
  readonly: boolean;
}

function StepEditModal({ initial, onSave, onCancel, readonly }: StepEditModalProps): JSX.Element {
  const [kind, setKind] = useState<StepKind>(initial?.kind ?? 'journal-append');
  const [fields, setFields] = useState<Record<string, string>>(() => {
    if (initial === null) return {};
    const s = initial as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'kind') continue;
      if (typeof v === 'string') out[k] = v;
      else if (typeof v === 'boolean') out[k] = v ? 'true' : 'false';
      else if (typeof v === 'number') out[k] = String(v);
      else if (typeof v === 'object' && v !== null) out[k] = JSON.stringify(v);
    }
    return out;
  });
  const [error, setError] = useState('');

  const setField = useCallback((key: string, value: string): void => {
    setFields((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleKindChange = useCallback((newKind: StepKind): void => {
    setKind(newKind);
    setFields({});
    setError('');
  }, []);

  const handleSave = useCallback((): void => {
    // 必須フィールド検証
    const requiredByKind: Record<StepKind, string[]> = {
      'journal-append': ['content'],
      'note-append': ['target', 'content'],
      'note-create': ['target', 'content'],
      'template-instantiate': ['template'],
      'prop-set': ['target'],
      'note-patch': ['target', 'old', 'new'],
      'agent-run': ['prompt'],
    };
    const missing = (requiredByKind[kind] ?? []).filter((k) => (fields[k] ?? '').trim() === '');
    if (missing.length > 0) {
      setError(`必須フィールドが未入力: ${missing.join(', ')}`);
      return;
    }

    // base (defaultStep) に含まれない任意フィールドの定義 (kind ごと)。
    // defaultStep は必須フィールドのみを返すため、フォームで入力できる任意フィールドを
    // ここで補完する。numeric なフィールドは number 型でシリアライズする。
    // agent-run の maxTurns/timeoutSec は shared スキーマで number 型 (int) のため、
    // 文字列止まりにせず number に変換する (数値シリアライズギャップの解消)。
    const optionalFields: Array<{ key: string; numeric: boolean }> =
      kind === 'agent-run'
        ? [
            { key: 'permissions', numeric: false },
            { key: 'maxTurns', numeric: true },
            { key: 'timeoutSec', numeric: true },
            { key: 'open', numeric: false },
          ]
        : [];

    // step オブジェクト構築
    const base = defaultStep(kind) as Record<string, unknown>;
    const built: Record<string, unknown> = { kind };
    for (const [k, defVal] of Object.entries(base)) {
      if (k === 'kind') continue;
      const userVal = fields[k];
      if (userVal !== undefined && userVal.trim() !== '') {
        built[k] = userVal;
      } else if (typeof defVal === 'string' && (requiredByKind[kind] ?? []).includes(k)) {
        built[k] = '';
      }
    }

    // base に含まれない任意フィールドを補完する (agent-run の maxTurns/timeoutSec 等)。
    for (const { key: k, numeric } of optionalFields) {
      if (k in built) continue;
      const userVal = fields[k];
      if (userVal === undefined || userVal.trim() === '') continue;
      if (numeric) {
        const n = Number(userVal.trim());
        if (!Number.isInteger(n)) {
          setError(`${k} は整数で入力してください`);
          return;
        }
        built[k] = n;
      } else {
        built[k] = userVal;
      }
    }

    // when / when-not
    if ((fields['when'] ?? '').trim() !== '') built['when'] = fields['when'];
    if ((fields['when-not'] ?? '').trim() !== '') built['when-not'] = fields['when-not'];

    // set フィールド (prop-set)
    if (kind === 'prop-set' && (fields['set'] ?? '').trim() !== '') {
      try {
        built['set'] = JSON.parse(fields['set'] ?? '{}') as Record<string, unknown>;
      } catch {
        // JSON parse 失敗なら文字列のまま
      }
    }

    onSave(built as unknown as CommandStep);
  }, [kind, fields, onSave]);

  // kind に応じたフィールド定義
  const fieldDefs: Array<{ key: string; label: string; multiline?: boolean; hint?: string; optional?: boolean }> = (() => {
    switch (kind) {
      case 'journal-append': return [
        { key: 'content', label: 'content (追記テキスト)' },
        { key: 'date', label: 'date', optional: true, hint: '省略時は今日' },
        { key: 'section', label: 'section', optional: true },
        { key: 'position', label: 'position', optional: true, hint: 'bottom / top / section' },
      ];
      case 'note-append': return [
        { key: 'target', label: 'target (ノートパス)' },
        { key: 'content', label: 'content (追記テキスト)', multiline: true },
        { key: 'section', label: 'section', optional: true },
        { key: 'position', label: 'position', optional: true, hint: 'bottom / top / section' },
        { key: 'create', label: 'create', optional: true, hint: 'true で存在しなければ作成' },
      ];
      case 'note-create': return [
        { key: 'target', label: 'target (ノートパス)' },
        { key: 'content', label: 'content (本文)', multiline: true },
      ];
      case 'template-instantiate': return [
        { key: 'template', label: 'template (テンプレートパス)' },
      ];
      case 'prop-set': return [
        { key: 'target', label: 'target (ノートパス)' },
        { key: 'set', label: 'set (JSON例: {"status":"done"})', optional: true, multiline: true },
      ];
      case 'note-patch': return [
        { key: 'target', label: 'target (ノートパス)' },
        { key: 'old', label: 'old (置換前テキスト)', multiline: true },
        { key: 'new', label: 'new (置換後テキスト)', multiline: true },
      ];
      case 'agent-run': return [
        { key: 'prompt', label: 'prompt (エージェントへの指示)', multiline: true, hint: '出力先も指示に含める (例: 当日ジャーナルの ## 議事録 へ追記)' },
        { key: 'maxTurns', label: 'maxTurns', optional: true, hint: '1..50 (省略時 20)' },
        { key: 'timeoutSec', label: 'timeoutSec', optional: true, hint: '10..600 (省略時 120)' },
      ];
    }
  })();

  return (
    <div
      className="param-form-backdrop"
      data-testid="step-edit-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="param-modal"
        data-testid="step-edit-modal"
        role="dialog"
        aria-label="ステップを編集"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ maxWidth: 560 }}
      >
        <div className="param-modal-head">
          <h2 data-testid="step-edit-title">{initial === null ? 'ステップを追加' : 'ステップを編集'}</h2>
          <button className="icon-btn" data-testid="step-edit-close" title="閉じる" onClick={onCancel}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>
        <div className="param-fields">
          {error !== '' && (
            <div style={{ margin: '0 0 8px', padding: '6px 10px', background: 'var(--danger-soft, rgba(224,82,99,.08))', borderRadius: 6, fontSize: 12, color: 'var(--danger, #e05263)' }}>
              {error}
            </div>
          )}
          <div className="param-field-row" data-testid="step-edit-field" data-name="kind">
            <label className="param-field-label">種別<span className="req">*</span></label>
            <select
              className="param-input"
              data-testid="step-edit-kind"
              value={kind}
              disabled={initial !== null || readonly} // 既存ステップは種別変更不可
              onChange={(e) => handleKindChange(e.target.value as StepKind)}
            >
              {STEP_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          {fieldDefs.map((fd) => (
            <div key={fd.key} className="param-field-row" data-testid="step-edit-field" data-name={fd.key}>
              <label className="param-field-label">
                {fd.label}
                {fd.optional === true ? <span className="opt">任意</span> : <span className="req">*</span>}
              </label>
              {fd.multiline === true ? (
                <textarea
                  className="param-input"
                  data-testid={`step-edit-${fd.key}`}
                  rows={3}
                  value={fields[fd.key] ?? ''}
                  disabled={readonly}
                  placeholder={fd.hint ?? ''}
                  onChange={(e) => setField(fd.key, e.target.value)}
                />
              ) : (
                <input
                  className="param-input"
                  data-testid={`step-edit-${fd.key}`}
                  type="text"
                  value={fields[fd.key] ?? ''}
                  disabled={readonly}
                  placeholder={fd.hint ?? ''}
                  onChange={(e) => setField(fd.key, e.target.value)}
                />
              )}
            </div>
          ))}
          <div className="param-field-row" data-testid="step-edit-field" data-name="when">
            <label className="param-field-label">when<span className="opt">任意</span></label>
            <input
              className="param-input"
              data-testid="step-edit-when"
              type="text"
              value={fields['when'] ?? ''}
              disabled={readonly}
              placeholder="実行条件 (truthy で実行)"
              onChange={(e) => setField('when', e.target.value)}
            />
          </div>
        </div>
        <div className="param-modal-foot">
          <div className="param-foot-actions">
            <button className="btn" data-testid="step-edit-cancel" onClick={onCancel}>キャンセル</button>
            <button className="btn primary" data-testid="step-edit-save" disabled={readonly} onClick={handleSave}>
              {initial === null ? '追加' : '更新'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- TestRunParamForm (CommandEditor.tsx の同名コンポーネントを再実装・軽量版) ----

interface TestRunParamFormProps {
  commandName: string;
  description: string | undefined;
  params: CommandParam[];
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

function todayDateStr(): string {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function TestRunParamForm({ commandName, description, params, onSubmit, onCancel }: TestRunParamFormProps): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of params) {
      init[p.name] = p.default !== undefined ? p.default : p.type === 'date' ? todayDateStr() : '';
    }
    return init;
  });
  const [showErrors, setShowErrors] = useState(false);

  const missingRequired = params.filter((p) => p.required === true && (values[p.name] ?? '').trim() === '').map((p) => p.name);

  const setValue = useCallback((name: string, value: string): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleSubmit = useCallback((): void => {
    if (missingRequired.length > 0) { setShowErrors(true); return; }
    onSubmit(values);
  }, [missingRequired, values, onSubmit]);

  return (
    <div
      className="param-form-backdrop"
      data-testid="param-form-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="param-modal"
        data-testid="param-form-modal"
        role="dialog"
        aria-label={`${commandName} — パラメータ入力`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="param-modal-head">
          <h2 data-testid="param-form-title">{commandName}</h2>
          {description !== undefined && <div className="sub">{description}</div>}
          <button className="icon-btn" data-testid="param-form-close" title="閉じる" onClick={onCancel}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>
        <div className="param-fields">
          {params.map((p) => {
            const invalid = showErrors && missingRequired.includes(p.name);
            return (
              <div
                key={p.name}
                className={`param-field-row${invalid ? ' invalid' : ''}`}
                data-testid="param-field"
                data-name={p.name}
                data-type={p.type ?? 'string'}
                data-required={p.required === true ? 'true' : 'false'}
              >
                <label className="param-field-label">
                  {p.label ?? p.name}
                  {p.required === true ? <span className="req">*</span> : <span className="opt">任意</span>}
                </label>
                {p.type === 'text' ? (
                  <textarea
                    className="param-input"
                    data-testid="param-field-input"
                    data-name={p.name}
                    rows={3}
                    value={values[p.name] ?? ''}
                    onChange={(e) => setValue(p.name, e.target.value)}
                  />
                ) : p.type === 'date' ? (
                  <input type="date" className="param-input" data-testid="param-field-input" data-name={p.name}
                    value={values[p.name] ?? ''} onChange={(e) => setValue(p.name, e.target.value)} />
                ) : p.type === 'select' && p.options !== undefined ? (
                  <select className="param-input" data-testid="param-field-input" data-name={p.name}
                    value={values[p.name] ?? ''} onChange={(e) => setValue(p.name, e.target.value)}>
                    <option value="">選択してください</option>
                    {p.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : (
                  <input type="text" className="param-input" data-testid="param-field-input" data-name={p.name}
                    value={values[p.name] ?? ''} onChange={(e) => setValue(p.name, e.target.value)} />
                )}
              </div>
            );
          })}
        </div>
        <div className="param-modal-foot">
          <div className="param-foot-actions">
            <button className="btn" data-testid="param-form-cancel" onClick={onCancel}>キャンセル</button>
            <button className="btn primary" data-testid="param-form-submit"
              aria-disabled={missingRequired.length > 0 ? 'true' : undefined}
              onClick={handleSubmit}>
              実行
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- アイコン ----

function IconSearch(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M14 14l-3.5-3.5" />
    </svg>
  );
}

function IconPlus(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M3 4.5h10M6.5 4V3h3v1M5 4.5l.5 8h5l.5-8" />
    </svg>
  );
}

function IconPencil(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" />
    </svg>
  );
}

function IconX(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function IconGrip(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <circle cx="6" cy="4" r="1.3" />
      <circle cx="10" cy="4" r="1.3" />
      <circle cx="6" cy="8" r="1.3" />
      <circle cx="10" cy="8" r="1.3" />
      <circle cx="6" cy="12" r="1.3" />
      <circle cx="10" cy="12" r="1.3" />
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

function IconPlay(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <polygon points="4,2 14,8 4,14" />
    </svg>
  );
}

// ---- ステップのサマリ表示 ----

function stepSummaryText(step: CommandStep): string {
  const s = step as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof s['target'] === 'string') parts.push(`→ ${s['target']}`);
  if (typeof s['content'] === 'string') {
    const snippet = s['content'].length > 25 ? `${s['content'].slice(0, 25)}…` : s['content'];
    parts.push(snippet);
  }
  if (typeof s['template'] === 'string') parts.push(`tmpl: ${s['template']}`);
  if (typeof s['old'] === 'string') parts.push(`old: ${s['old'].slice(0, 15)}`);
  return parts.join(' · ');
}

// ---- CommandsPanel (main) ----

export function CommandsPanel({ mode }: CommandsPanelProps): JSX.Element {
  const readonly = mode === 'read-only' || mode === 'append-only';

  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommandDraft | null>(null);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  // param/step 編集モーダル
  const [paramEditIndex, setParamEditIndex] = useState<number | null>(null); // -1 = 新規
  const [stepEditIndex, setStepEditIndex] = useState<number | null>(null);   // -1 = 新規

  // 試し実行ステートマシン
  const [runPhase, setRunPhase] = useState<RunPhase>({ phase: 'idle' });

  // ドラッグ
  const paramDragRef = useRef<number | null>(null);
  const stepDragRef = useRef<number | null>(null);
  const [paramDragOver, setParamDragOver] = useState<number | null>(null);
  const [stepDragOver, setStepDragOver] = useState<number | null>(null);

  // ---- コマンド一覧ロード ----

  const loadCommands = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const cmds = await api.listCommands();
      setCommands(cmds);
    } catch {
      setCommands([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCommands();
  }, [loadCommands]);

  // ---- アイテム選択 ----

  const selectItem = useCallback(async (cmd: CommandSummary): Promise<void> => {
    setSelectedId(cmd.id);
    setSaveStatus('idle');
    setSaveError(null);
    setRunPhase({ phase: 'idle' });
    setParamEditIndex(null);
    setStepEditIndex(null);

    // YAML ソースを読み込んでパース
    try {
      const res = await api.getCommandSource(cmd.id);
      const parsed = parseLoamiumCommandFileWithError(res.content);
      const lcmd: LoamiumCommand | null = parsed.ok ? parsed.command : null;
      setDraft({
        id: cmd.id,
        name: lcmd?.name ?? cmd.name,
        description: lcmd?.description ?? (cmd.valid ? (cmd.description ?? '') : ''),
        params: lcmd?.params ?? (cmd.valid ? cmd.params : []),
        steps: lcmd?.steps ?? [],
        yamlSource: res.content,
        mtime: res.mtime ?? null,
      });
    } catch {
      // ソース取得失敗: summary から復元
      const name = cmd.valid ? cmd.name : cmd.id;
      const description = cmd.valid ? (cmd.description ?? '') : '';
      const params = cmd.valid ? cmd.params : [];
      setDraft({
        id: cmd.id,
        name,
        description,
        params,
        steps: [],
        yamlSource: '',
        mtime: null,
      });
    }
  }, []);

  // 初期選択
  useEffect(() => {
    const first = commands[0];
    if (first !== undefined && selectedId === null) {
      void selectItem(first);
    }
  }, [commands, selectedId, selectItem]);

  // ---- 新規作成 ----

  const createNew = useCallback(async (): Promise<void> => {
    const stem = `new-command-${Date.now().toString(36)}`;
    const defaultYaml = `name: 新しいコマンド\ndescription: ''\nsteps:\n  - kind: journal-append\n    content: ''\n`;
    try {
      const res = await api.putCommandSource(stem, defaultYaml);
      await loadCommands();
      setSelectedId(stem);
      setDraft({
        id: stem,
        name: '新しいコマンド',
        description: '',
        params: [],
        steps: [{ kind: 'journal-append', content: '' }],
        yamlSource: defaultYaml,
        mtime: res.mtime,
      });
      setSaveStatus('idle');
      setSaveError(null);
      setRunPhase({ phase: 'idle' });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [loadCommands]);

  // ---- 保存 ----

  const save = useCallback(async (): Promise<void> => {
    if (draft === null) return;
    if (draft.steps.length === 0) {
      setSaveError('ステップが 1 つ以上必要です');
      setSaveStatus('error');
      return;
    }
    setSaveStatus('saving');
    setSaveError(null);

    const yaml = commandToYaml({
      name: draft.name,
      description: draft.description,
      params: draft.params,
      steps: draft.steps,
    });

    try {
      const res = await api.putCommandSource(draft.id, yaml, draft.mtime ?? undefined);
      setDraft((prev) => prev !== null ? { ...prev, yamlSource: yaml, mtime: res.mtime } : prev);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
      await loadCommands();
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [draft, loadCommands]);

  // ---- キャンセル ----

  const cancel = useCallback(async (): Promise<void> => {
    if (draft === null || selectedId === null) return;
    const cmd = commands.find((c) => c.id === selectedId);
    if (cmd !== undefined) {
      await selectItem(cmd);
    }
    setSaveStatus('idle');
    setSaveError(null);
  }, [draft, selectedId, commands, selectItem]);

  // ---- 削除 ----

  const deleteCommand = useCallback(async (): Promise<void> => {
    if (draft === null) return;
    if (!window.confirm(`「${draft.name}」を削除しますか？`)) return;

    try {
      // system/commands/{id}.yaml を system-files API で削除
      await api.deleteSystemFile(`system/commands/${draft.id}.yaml`);
      const newCommands = commands.filter((c) => c.id !== draft.id);
      setCommands(newCommands);
      const first = newCommands[0];
      if (first !== undefined) {
        await selectItem(first);
      } else {
        setSelectedId(null);
        setDraft(null);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [draft, commands, selectItem]);

  // ---- 試し実行 ----

  const handleTestRun = useCallback((): void => {
    if (draft === null) return;
    if (draft.params.length > 0) {
      setRunPhase({ phase: 'param-form' });
    } else {
      setRunPhase({ phase: 'running' });
      void (async (): Promise<void> => {
        try {
          // 未保存なら先に保存
          if (saveStatus !== 'saved') {
            await save();
          }
          const result = await api.runCommand(draft.id, {});
          setRunPhase({ phase: 'done', result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setRunPhase({ phase: 'error', message: msg });
        }
      })();
    }
  }, [draft, saveStatus, save]);

  const doRun = useCallback(async (collectedParams: Record<string, string>): Promise<void> => {
    if (draft === null) return;
    setRunPhase({ phase: 'running' });
    try {
      const result = await api.runCommand(draft.id, collectedParams);
      setRunPhase({ phase: 'done', result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunPhase({ phase: 'error', message: msg });
    }
  }, [draft]);

  // ---- param 操作 ----

  const updateParam = useCallback((index: number, updated: CommandParam): void => {
    setDraft((prev) => {
      if (prev === null) return prev;
      const newParams = [...prev.params];
      newParams[index] = updated;
      return { ...prev, params: newParams };
    });
  }, []);

  const addParam = useCallback((p: CommandParam): void => {
    setDraft((prev) => {
      if (prev === null) return prev;
      return { ...prev, params: [...prev.params, p] };
    });
  }, []);

  const deleteParam = useCallback((index: number): void => {
    setDraft((prev) => {
      if (prev === null) return prev;
      const newParams = prev.params.filter((_, i) => i !== index);
      return { ...prev, params: newParams };
    });
  }, []);

  const reorderParams = useCallback((fromIndex: number, toIndex: number): void => {
    setDraft((prev) => {
      if (prev === null) return prev;
      const reordered = [...prev.params];
      const [moved] = reordered.splice(fromIndex, 1);
      if (moved === undefined) return prev;
      reordered.splice(toIndex, 0, moved);
      return { ...prev, params: reordered };
    });
  }, []);

  // ---- step 操作 ----

  const updateStep = useCallback((index: number, updated: CommandStep): void => {
    setDraft((prev) => {
      if (prev === null) return prev;
      const newSteps = [...prev.steps];
      newSteps[index] = updated;
      return { ...prev, steps: newSteps };
    });
  }, []);

  const addStep = useCallback((s: CommandStep): void => {
    setDraft((prev) => {
      if (prev === null) return prev;
      return { ...prev, steps: [...prev.steps, s] };
    });
  }, []);

  const deleteStep = useCallback((index: number): void => {
    setDraft((prev) => {
      if (prev === null) return prev;
      const newSteps = prev.steps.filter((_, i) => i !== index);
      return { ...prev, steps: newSteps };
    });
  }, []);

  const reorderSteps = useCallback((fromIndex: number, toIndex: number): void => {
    setDraft((prev) => {
      if (prev === null) return prev;
      const reordered = [...prev.steps];
      const [moved] = reordered.splice(fromIndex, 1);
      if (moved === undefined) return prev;
      reordered.splice(toIndex, 0, moved);
      return { ...prev, steps: reordered };
    });
  }, []);

  // ---- フィルタ ----

  const filteredCommands = filterText.trim() === ''
    ? commands
    : commands.filter((cmd) => {
        const q = filterText.trim().toLowerCase();
        const nm = (cmd.valid ? cmd.name : cmd.id).toLowerCase();
        const desc = cmd.valid ? (cmd.description ?? '').toLowerCase() : '';
        return nm.includes(q) || desc.includes(q);
      });

  // ---- ドラッグ param ----

  const handleParamDragStart = useCallback((e: DragEvent<HTMLDivElement>, index: number): void => {
    paramDragRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleParamDragOver = useCallback((e: DragEvent<HTMLDivElement>, index: number): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setParamDragOver(index);
  }, []);

  const handleParamDrop = useCallback((e: DragEvent<HTMLDivElement>, dropIndex: number): void => {
    e.preventDefault();
    const fromIndex = paramDragRef.current;
    paramDragRef.current = null;
    setParamDragOver(null);
    if (fromIndex === null || fromIndex === dropIndex) return;
    reorderParams(fromIndex, dropIndex);
  }, [reorderParams]);

  // ---- ドラッグ step ----

  const handleStepDragStart = useCallback((e: DragEvent<HTMLDivElement>, index: number): void => {
    stepDragRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleStepDragOver = useCallback((e: DragEvent<HTMLDivElement>, index: number): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setStepDragOver(index);
  }, []);

  const handleStepDrop = useCallback((e: DragEvent<HTMLDivElement>, dropIndex: number): void => {
    e.preventDefault();
    const fromIndex = stepDragRef.current;
    stepDragRef.current = null;
    setStepDragOver(null);
    if (fromIndex === null || fromIndex === dropIndex) return;
    reorderSteps(fromIndex, dropIndex);
  }, [reorderSteps]);

  // ---- 試し実行結果表示 ----

  const runResult = runPhase.phase === 'done' ? runPhase.result : null;
  const runError = runPhase.phase === 'error' ? runPhase.message : null;
  const showRunResult = runResult !== null || runError !== null;

  // ---- render ----

  return (
    <section
      className="md-panel active"
      data-testid="md-panel"
      data-group="commands"
    >
      {/* 左: master */}
      <div className="md-master" data-testid="md-master">
        <div className="md-master-head">
          <h2>スマートコマンド</h2>
          <button
            type="button"
            className="md-new"
            data-testid="md-new"
            title="新規コマンド"
            disabled={readonly}
            onClick={() => void createNew()}
          >
            <IconPlus />
          </button>
        </div>
        <div className="md-filter" data-testid="md-filter">
          <IconSearch />
          <input
            type="text"
            placeholder="絞り込み"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            data-testid="md-filter-input"
            aria-label="コマンドを絞り込み"
          />
        </div>
        <div className="md-items" data-testid="md-items" data-items="commands">
          {loading && <div className="md-items-empty">読み込み中…</div>}
          {!loading && filteredCommands.length === 0 && (
            <div className="md-items-empty" data-testid="md-items-empty">コマンドがありません</div>
          )}
          {filteredCommands.map((cmd) => {
            const nm = cmd.valid ? cmd.name : cmd.id;
            const sb = cmd.valid
              ? `${String(cmd.params.length)} パラメータ`
              : '無効なコマンド';
            return (
              <button
                key={cmd.id}
                type="button"
                className={`md-item${selectedId === cmd.id ? ' active' : ''}`}
                data-testid="md-item"
                data-id={cmd.id}
                onClick={() => void selectItem(cmd)}
              >
                <span className="ic">
                  <IconCommand />
                </span>
                <span className="txt">
                  <div className="nm">{nm}</div>
                  <div className="sb">{sb}</div>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右: detail */}
      {draft !== null ? (
        <div className="md-detail" data-testid="md-detail">
          {/* ヘッダ: 編集可能タイトル */}
          <div className="md-detail-header">
            <div className="detail-title-wrap">
              <input
                type="text"
                className="detail-title"
                data-testid="detail-title"
                aria-label="コマンド名"
                value={draft.name}
                disabled={readonly}
                onChange={(e) => setDraft((prev) => prev !== null ? { ...prev, name: e.target.value } : prev)}
              />
              <div className="detail-path" data-testid="detail-path">
                {`system/commands/${draft.id}.yaml`}
              </div>
            </div>
            {saveStatus === 'error' && (
              <span className="md-save-error">{saveError}</span>
            )}
            {saveStatus === 'saved' && (
              <span className="md-save-ok">保存済み</span>
            )}
          </div>

          {/* 本体 */}
          <div className="md-detail-body" style={{ padding: '16px 28px', overflowY: 'auto' }} data-testid="cmd-detail-body">
            {/* 説明フィールド */}
            <div className="cmd-hub-field" data-testid="cmd-description-field">
              <label className="cmd-hub-label">説明</label>
              <input
                type="text"
                className="cmd-hub-input"
                data-testid="cmd-description"
                value={draft.description}
                disabled={readonly}
                placeholder="パレットのサブテキストに表示されます"
                onChange={(e) => setDraft((prev) => prev !== null ? { ...prev, description: e.target.value } : prev)}
              />
            </div>

            {/* パラメータ一覧 */}
            <div className="cmd-hub-section-label" data-testid="cmd-params-label">パラメータ</div>
            <div data-testid="cmd-params-list">
              {draft.params.length === 0 && (
                <div className="cmd-hub-empty" data-testid="cmd-params-empty">パラメータなし</div>
              )}
              {draft.params.map((p, i) => (
                <div
                  key={`param-${i}`}
                  className={`cmd-hub-row${paramDragOver === i ? ' drag-over' : ''}`}
                  data-testid="cmd-param-row"
                  data-name={p.name}
                  data-type={p.type ?? 'string'}
                  data-required={p.required === true ? 'true' : 'false'}
                  draggable={!readonly}
                  onDragStart={(e) => handleParamDragStart(e, i)}
                  onDragOver={(e) => handleParamDragOver(e, i)}
                  onDrop={(e) => handleParamDrop(e, i)}
                  onDragEnd={() => { paramDragRef.current = null; setParamDragOver(null); }}
                >
                  <span className="cmd-hub-grip" aria-hidden="true" data-testid="param-drag-handle">
                    <IconGrip />
                  </span>
                  <span className="cmd-hub-tag" data-testid="cmd-param-type-tag">{p.type ?? 'string'}</span>
                  <span className="cmd-hub-main">
                    {p.name}
                    {p.label !== undefined && p.label !== '' && (
                      <span className="cmd-hub-sub"> ({p.label})</span>
                    )}
                    {p.required === true && <span className="cmd-hub-sub"> · 必須</span>}
                  </span>
                  <button
                    type="button"
                    className="cmd-hub-act"
                    data-testid="cmd-param-edit"
                    data-index={i}
                    title="編集"
                    disabled={readonly}
                    onClick={() => setParamEditIndex(i)}
                  >
                    <IconPencil />
                  </button>
                  <button
                    type="button"
                    className="cmd-hub-act cmd-hub-del"
                    data-testid="cmd-param-delete"
                    data-index={i}
                    title="削除"
                    disabled={readonly}
                    onClick={() => deleteParam(i)}
                  >
                    <IconX />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="cmd-hub-add"
              data-testid="cmd-param-add"
              disabled={readonly}
              onClick={() => setParamEditIndex(-1)}
            >
              ＋ パラメータを追加
            </button>

            {/* ステップ一覧 */}
            <div className="cmd-hub-section-label" style={{ marginTop: 24 }} data-testid="cmd-steps-label">ステップ</div>
            <div data-testid="cmd-steps-list">
              {draft.steps.length === 0 && (
                <div className="cmd-hub-empty" data-testid="cmd-steps-empty">ステップなし (1 つ以上必須)</div>
              )}
              {draft.steps.map((step, i) => {
                const summary = stepSummaryText(step);
                return (
                  <div
                    key={`step-${i}`}
                    className={`cmd-hub-row${stepDragOver === i ? ' drag-over' : ''}`}
                    data-testid="cmd-step-row"
                    data-index={String(i)}
                    data-kind={step.kind}
                    draggable={!readonly}
                    onDragStart={(e) => handleStepDragStart(e, i)}
                    onDragOver={(e) => handleStepDragOver(e, i)}
                    onDrop={(e) => handleStepDrop(e, i)}
                    onDragEnd={() => { stepDragRef.current = null; setStepDragOver(null); }}
                  >
                    <span className="cmd-hub-grip" aria-hidden="true" data-testid="step-drag-handle">
                      <IconGrip />
                    </span>
                    <span className="cmd-hub-tag cmd-hub-tag-step" data-testid="cmd-step-kind-tag">{step.kind}</span>
                    <span className="cmd-hub-main">
                      <span className="cmd-hub-sub">{summary}</span>
                    </span>
                    <button
                      type="button"
                      className="cmd-hub-act"
                      data-testid="cmd-step-edit"
                      data-index={i}
                      title="編集"
                      disabled={readonly}
                      onClick={() => setStepEditIndex(i)}
                    >
                      <IconPencil />
                    </button>
                    <button
                      type="button"
                      className="cmd-hub-act cmd-hub-del"
                      data-testid="cmd-step-delete"
                      data-index={i}
                      title="削除"
                      disabled={readonly}
                      onClick={() => deleteStep(i)}
                    >
                      <IconX />
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="cmd-hub-add"
              data-testid="cmd-step-add"
              disabled={readonly}
              onClick={() => setStepEditIndex(-1)}
            >
              ＋ ステップを追加
            </button>

            {/* 試し実行結果 [AC-Sa100c6-3-2] */}
            {showRunResult && (
              <div className="cmd-hub-run-result" data-testid="cmd-run-result" style={{ marginTop: 20 }}>
                {runResult !== null && (
                  <>
                    <div
                      className={`cmd-run-result-head${runResult.results.some((r) => !r.ok) ? ' failure' : ' success'}`}
                      data-testid="cmd-run-result-status"
                    >
                      {runResult.results.every((r) => r.ok) ? '✓ 実行成功' : '✗ 実行失敗'}
                    </div>
                    {runResult.results.map((sr, idx) => (
                      <div
                        key={`${sr.kind}-${idx}`}
                        className="step-result"
                        data-testid="step-result"
                        data-kind={sr.kind}
                        data-ok={sr.ok ? 'true' : 'false'}
                      >
                        <span>{sr.ok ? '✓' : '✗'}</span>
                        <span className="step-kind">{sr.kind}</span>
                        {sr.path !== undefined && <span>{sr.path}</span>}
                        {sr.error !== undefined && <span style={{ color: 'var(--danger, #e05263)' }}>{sr.error}</span>}
                      </div>
                    ))}
                  </>
                )}
                {runError !== null && (
                  <div
                    className="step-result"
                    data-testid="step-result"
                    data-kind="request"
                    data-ok="false"
                  >
                    <span>✗</span>
                    <span className="step-kind">request</span>
                    <span style={{ color: 'var(--danger, #e05263)' }}>{runError}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* フッタ [AC-Sa100c6-3-1] [AC-Sa100c6-3-2] */}
          <div className="md-detail-footer" data-testid="md-detail-footer">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="md-save"
              disabled={readonly || saveStatus === 'saving'}
              onClick={() => void save()}
            >
              {saveStatus === 'saving' ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="md-cancel"
              onClick={() => void cancel()}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="cmd-test-run"
              disabled={readonly || runPhase.phase === 'running' || draft.steps.length === 0}
              onClick={handleTestRun}
            >
              <IconPlay />
              {runPhase.phase === 'running' ? '実行中…' : '試し実行'}
            </button>
            <button
              type="button"
              className="btn btn-ghost danger"
              data-testid="md-delete"
              style={{ marginLeft: 'auto' }}
              disabled={readonly}
              onClick={() => void deleteCommand()}
            >
              <IconTrash />
              削除
            </button>
          </div>
        </div>
      ) : (
        <div className="md-detail md-detail-empty" data-testid="md-detail">
          <div className="md-empty-msg">
            {loading ? '読み込み中…' : 'コマンドを選択するか、新規作成してください'}
          </div>
        </div>
      )}

      {/* パラメータ編集モーダル */}
      {paramEditIndex !== null && (
        <ParamEditModal
          initial={paramEditIndex === -1 ? null : (draft?.params[paramEditIndex] ?? null)}
          onSave={(p) => {
            if (paramEditIndex === -1) addParam(p);
            else updateParam(paramEditIndex, p);
            setParamEditIndex(null);
          }}
          onCancel={() => setParamEditIndex(null)}
          readonly={readonly}
        />
      )}

      {/* ステップ編集モーダル */}
      {stepEditIndex !== null && (
        <StepEditModal
          initial={stepEditIndex === -1 ? null : (draft?.steps[stepEditIndex] ?? null)}
          onSave={(s) => {
            if (stepEditIndex === -1) addStep(s);
            else updateStep(stepEditIndex, s);
            setStepEditIndex(null);
          }}
          onCancel={() => setStepEditIndex(null)}
          readonly={readonly}
        />
      )}

      {/* 試し実行: param 入力フォーム */}
      {runPhase.phase === 'param-form' && draft !== null && (
        <TestRunParamForm
          commandName={draft.name}
          description={draft.description !== '' ? draft.description : undefined}
          params={draft.params}
          onSubmit={(values) => { void doRun(values); }}
          onCancel={() => setRunPhase({ phase: 'idle' })}
        />
      )}
    </section>
  );
}
