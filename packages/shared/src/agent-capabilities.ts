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
 *   - read             : 既存の読み取り系 (search/query/read_note/backlinks/tags) + help
 *                        + スマートフォルダ読み取り (smartfolders_list / smartfolder_notes)
 *   - journal_append   : ジャーナルへの追記
 *   - note_create      : ノート新規作成
 *   - note_edit        : ノート編集 (patch) + フロントマタープロパティ/タグ編集 (note_property)
 *                        + ノートのリネーム/移動 (note_move。[[リンク]]一括追従)
 *   - note_delete      : ノート削除 (破壊的・不可逆)。書き込み系の独立ケーパビリティで full のみ許可。
 *   - template_write   : テンプレート適用による書き込み
 *   - dataview_write   : dataview 経由の書き込み
 *   - file_write       : 添付ファイル (非 .md) の作成/上書き (file_write) ・リネーム/移動
 *                        (file_move。![[リンク]]追従) ・削除 (file_delete)。全 file 系書き込みを
 *                        畳む独立ケーパビリティで full のみ許可 (clampByMode)。
 *   - smartfolder_write: スマートフォルダ (ビュー定義) の書き込み・削除
 *                        (ADR-0016 / Sc4b9d1: system/smart-folders/*.yaml サービス層経由)
 *   - command_run      : スマートコマンドのステップ実行 (ADR-0016/0021 / Sc4b9d1-2:
 *                        POST /api/commands/{name}/run と同一エンジン)。書き込みを伴う
 *                        独立ケーパビリティで full のみ許可 (commands 一覧は read で広告)。
 *   - command_write    : スマートコマンド定義 (YAML) の作成・更新・削除 (ADR-0016:
 *                        system/commands/*.yaml を writeSystemCommand/deleteSystemCommand 経由で
 *                        authoring)。書き込み系の独立ケーパビリティで full のみ許可。
 *   - vault_seed       : サンプルファイルの vault 投入 (S7e2d5c-1: POST /api/vault/seed と
 *                        同一の SeedService 経由)。書き込み系のため full のみ許可。
 *   - web              : Web アクセス (ADR-0017 / S5e0206: web_fetch / web_search)
 */
export const AGENT_CAPABILITIES = [
  'read',
  'journal_append',
  'note_create',
  'note_edit',
  'note_delete',
  'template_write',
  'dataview_write',
  'file_write',
  'smartfolder_write',
  'command_run',
  'command_write',
  'vault_seed',
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
 *   - full      : 全ケーパビリティ (AGENT_CAPABILITIES)
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
  // read はノート読み取り群 + help + スマートフォルダ読み取り (一覧・解決) を広告する。
  // スマートフォルダ読み取りは GET /api/smart-folders と同じ readConfig / notes 解決経路を
  // 通す純関数ツール (ADR-0016 / Sc4b9d1)。
  read: [
    'backlinks',
    'commands_list',
    'help',
    'query',
    'read_note',
    'search',
    'smartfolder_notes',
    'smartfolders_list',
    'tags',
    'templates_list',
  ],
  journal_append: ['journal_append'],
  note_create: ['note_create'],
  // note_edit はノート patch 編集 (note_edit) + フロントマタープロパティ/タグ編集 (note_property)
  // + リネーム/移動 (note_move。[[リンク]]一括追従) を広告する (編集系のため同一ケーパビリティに畳む)。
  note_edit: ['note_edit', 'note_move', 'note_property'],
  // note_delete は破壊的なノート削除。独立ケーパビリティで full のみ許可 (MODE_ALLOWED)。
  note_delete: ['note_delete'],
  // template_write はテンプレート適用によるノート生成を広告する (Sc4b9d1-3):
  //   - template_write     : テンプレート authoring (作成/更新。overwrite で上書き)
  //   - template_delete    : テンプレート削除 (破壊的。既存 template_write に畳む)
  //   - template_instantiate: POST /api/templates/{name}/instantiate と同一解決エンジン
  //     (テンプレート適用 = ノート生成 = 書き込み系のため既存 template_write を再利用する)。
  template_write: ['template_delete', 'template_instantiate', 'template_write'],
  dataview_write: ['dataview_write'],
  // file_write は添付ファイル (非 .md) の作成/上書き・リネーム/移動・削除を広告する。
  // 書き込み系のため full のみで許可される (clampByMode / MODE_ALLOWED)。
  file_write: ['file_delete', 'file_move', 'file_write'],
  // smartfolder_write はスマートフォルダ (ビュー定義) の作成・更新・削除を広告する。
  // 書き込み系のため full のみで許可される (clampByMode / MODE_ALLOWED)。
  smartfolder_write: ['smartfolder_delete', 'smartfolder_write'],
  // command_run はスマートコマンドのステップ実行 (command_run ツール) を広告する。
  // 書き込みを伴うため full のみで許可される (clampByMode / MODE_ALLOWED)。
  command_run: ['command_run'],
  // command_write はスマートコマンド定義の作成/更新/削除を広告する。
  // 書き込み系のため full のみで許可される (clampByMode / MODE_ALLOWED)。
  command_write: ['command_delete', 'command_write'],
  // vault_seed はサンプルファイルの vault 投入ツールを広告する (S7e2d5c-1)。
  // POST /api/vault/seed と同一の SeedService 経由。書き込み系のため full のみで許可。
  vault_seed: ['vault_seed'],
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
 * smartfolder_write は書き込み系のため read-only/append-only では残さない = full のみ許可
 * (両集合に含めないことで表と一貫させる)。
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

// ---- 自己昇格防止: 設定書込 API の agent ツール除外 (ADR-0026 / Sa10026-6) ----

/**
 * 設定書込 API ルート (Sa10026-5) に対応する「想定されうる」ツール名パターン。
 *
 * ADR-0026 設計制約 (binding):
 *   - `/api/settings/agent/permissions`, `/api/settings/agent/privacy`,
 *     `/api/settings/agent/connection` の apiKey 書込は agent 自身が実行できてはならない。
 *   - CAPABILITY_TOOL_NAMES に settings 系ケーパビリティは存在せず、deriveToolNames は
 *     いかなる caps 集合を渡されても設定書込ツールを返さない (構造的除外)。
 *
 * この定数は「設定書込に相当するツール名が advertised-toolset に**現れないことを固定**する
 * 回帰テスト (AC-Sa10026-6-2)」で参照される。
 * 新しい settings ケーパビリティを追加する場合はこのリストも更新し、
 * テストが失敗することで自己昇格の危険を検出できるようにする。
 *
 * [AC-Sa10026-6-1] agent ツール allowlist から設定書込を除外する構造的保証。
 */
export const SETTINGS_EXCLUDED_TOOL_NAMES = [
  // settings write API に対応するツール名候補 (現在は存在しないが将来の誤追加を pin する)
  'settings_write',
  'settings_system_write',
  'settings_agent_write',
  'settings_agent_connection_write',
  'settings_agent_permissions_write',
  'settings_agent_privacy_write',
  'agent_config_write',
  'agent_permission_write',
  'agent_privacy_write',
  'agent_connection_write',
] as const;
