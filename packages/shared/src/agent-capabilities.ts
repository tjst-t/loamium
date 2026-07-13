/**
 * エージェントのケーパビリティ権限モデル (ADR-0015)。
 *
 * 権限はケーパビリティ別トグルの集合で表現する。各ケーパビリティは独立に on/off でき、
 * 有効なケーパビリティ集合から LLM に広告されるツール集合を導出する。
 *
 * 責務:
 *   - `resolvePermissions`: agent.json の permissions (プリセット名 or ケーパビリティ配列) を
 *     有効ケーパビリティ集合へ解決する。未指定なら read-only プリセット。
 *   - `deriveToolNames`: 有効ケーパビリティ集合 → LLM 広告ツール名集合。
 *   - `clampByMode`: 実効権限 = 権限 ∩ サーバー LOAMIUM_MODE (クランプ表に従う)。
 *
 * 正本 (source of truth) はマシンローカルの agent.json / セッション権限ストアであり、
 * サーバーは常に LOAMIUM_MODE で最終クランプして強制する (defense-in-depth)。
 */
import { z } from 'zod';
import type { PermissionMode } from './schemas.js';

// ---- ケーパビリティ定義 -----------------------------------------------------

/**
 * エージェントが持ちうる全ケーパビリティ (ADR-0015)。
 *   - read           : 既存の読み取り系 (search/query/read_note/backlinks/tags) + help
 *   - journal_append : ジャーナルへの追記
 *   - note_create    : ノート新規作成
 *   - note_edit      : ノート編集
 *   - template_write : テンプレート適用による書き込み
 *   - dataview_write : dataview 経由の書き込み
 *   - web            : Web アクセス (ADR-0017 / S5e0206: web_fetch / web_search)
 */
export const AGENT_CAPABILITIES = [
  'read',
  'journal_append',
  'note_create',
  'note_edit',
  'template_write',
  'dataview_write',
  'web',
] as const;
export type Capability = (typeof AGENT_CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(AGENT_CAPABILITIES);

function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

// ---- プリセット --------------------------------------------------------------

/** プリセット名 (チャット UI / agent.json で使う短縮指定)。 */
export const AGENT_PRESET_NAMES = ['read-only', 'notes-rw', 'full'] as const;
export type AgentPresetName = (typeof AGENT_PRESET_NAMES)[number];

/**
 * プリセット名 → ケーパビリティ集合 (ADR-0015)。
 *   - read-only : [read]
 *   - notes-rw  : [read, journal_append, note_create, note_edit]
 *   - full      : 全 7 ケーパビリティ
 */
export const AGENT_PRESETS: Record<AgentPresetName, Capability[]> = {
  'read-only': ['read'],
  'notes-rw': ['read', 'journal_append', 'note_create', 'note_edit'],
  full: [...AGENT_CAPABILITIES],
};

// ---- zod スキーマ ------------------------------------------------------------

const capabilitySchema = z.enum(AGENT_CAPABILITIES);
const presetNameSchema = z.enum(AGENT_PRESET_NAMES);

/**
 * agent.json / セッション作成の `permissions` フィールドのスキーマ。
 * プリセット名 (enum) **または** ケーパビリティ配列のどちらかを受け付ける。
 */
export const agentPermissionsSchema = z.union([
  presetNameSchema,
  z.array(capabilitySchema),
]);
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;

// ---- 解決 --------------------------------------------------------------------

/**
 * permissions 入力 (プリセット名 or ケーパビリティ配列 or 未指定) を
 * 有効ケーパビリティ集合へ解決する。
 *
 * - 未指定 (undefined) → read-only プリセット ([read]) が既定 (AC-S5bd678-1-1)。
 * - プリセット名 → AGENT_PRESETS のケーパビリティ集合。
 * - ケーパビリティ配列 → 重複排除して正規化 (順序は AGENT_CAPABILITIES 順)。
 */
export function resolvePermissions(input: AgentPermissions | undefined): Capability[] {
  if (input === undefined) {
    return [...AGENT_PRESETS['read-only']];
  }
  if (typeof input === 'string') {
    return [...AGENT_PRESETS[input]];
  }
  return normalizeCapabilities(input);
}

/** ケーパビリティ配列を AGENT_CAPABILITIES 順に整列し重複排除する。 */
function normalizeCapabilities(caps: readonly Capability[]): Capability[] {
  const present = new Set<string>(caps);
  return AGENT_CAPABILITIES.filter((c) => present.has(c));
}

// ---- ツール名導出 ------------------------------------------------------------

/**
 * ケーパビリティ → そのケーパビリティが広告するツール名の集合。
 *
 * ADR-0014: help はどの権限セットでも利用可能であるべき。read が最小プリセットの
 * 既定なので read 群に help を含めるが、caps に read が無くても help は常に広告する
 * (deriveToolNames 側で保証する)。
 *
 * web は ADR-0017 (S5e0206) で web_fetch / web_search を広告する。
 * 既定 off の独立ケーパビリティであり、有効なとき (effectiveCaps に含まれるとき) だけ
 * これらのツールが広告される (clampByMode は web を read-only/append-only でも残す = 既存)。
 */
const CAPABILITY_TOOL_NAMES: Record<Capability, readonly string[]> = {
  read: ['backlinks', 'help', 'query', 'read_note', 'search', 'tags'],
  journal_append: ['journal_append'],
  note_create: ['note_create'],
  note_edit: ['note_edit'],
  template_write: ['template_write'],
  dataview_write: ['dataview_write'],
  web: ['web_fetch', 'web_search'],
};

/**
 * 有効ケーパビリティ集合 → LLM に広告するツール名集合。
 *
 * - 各ケーパビリティのツール名を集約し、重複排除・ソートして返す。
 * - help 常時広告 (ADR-0014): caps に read が無い場合でも help は必ず含める。
 *   help はどの権限セットでも使えるべきツールであるため。
 */
export function deriveToolNames(caps: readonly Capability[]): string[] {
  const names = new Set<string>();
  for (const cap of caps) {
    for (const name of CAPABILITY_TOOL_NAMES[cap]) {
      names.add(name);
    }
  }
  // help 常時広告 — read が無くても help だけは常に広告する (ADR-0014)。
  names.add('help');
  return [...names].sort();
}

// ---- モードによるクランプ ----------------------------------------------------

/**
 * サーバー LOAMIUM_MODE ごとに残すケーパビリティの許可集合 (クランプ表, AC-S5bd678-1-2)。
 *   - full        : 恒等 (すべて残す)
 *   - read-only   : {read, web} のみ残す
 *   - append-only : {read, web, journal_append} のみ残す
 *
 * full は null で表現 (フィルタ無し = 恒等)。
 */
const MODE_ALLOWED: Record<PermissionMode, ReadonlySet<Capability> | null> = {
  full: null,
  'read-only': new Set<Capability>(['read', 'web']),
  'append-only': new Set<Capability>(['read', 'web', 'journal_append']),
};

/**
 * 実効権限 = エージェント権限 ∩ サーバー LOAMIUM_MODE (AC-S5bd678-1-2)。
 * クランプ表 (MODE_ALLOWED) に従い、mode が許可しないケーパビリティを取り除く。
 * サーバー側で必ず適用して強制する。
 */
export function clampByMode(caps: readonly Capability[], mode: PermissionMode): Capability[] {
  const normalized = normalizeCapabilities(caps);
  const allowed = MODE_ALLOWED[mode];
  if (allowed === null) return normalized;
  return normalized.filter((c) => allowed.has(c));
}
