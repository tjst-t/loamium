/**
 * 意味型システム (D方式) — キーごとの意味型の解決 (S87f4b7-2)。
 *
 * ノートの frontmatter は常に標準 YAML スカラーのまま (ピュア Markdown 厳守 —
 * DESIGN_PRINCIPLES priority 1)。意味型は「表示層でどう描画・編集するか」を決める
 * ためだけの解決であり、ファイルには一切書き込まない。
 *
 * 解決の順序 (AC-S87f4b7-2-1):
 *   1. `.loamium/property-types.json` の「キー → 型定義」があればそれで上書き
 *   2. 無ければ内蔵ヒューリスティック (キー名 + 値の形) で推定
 *
 * `.loamium/property-types.json` が壊れていてもクラッシュしない (AC-2-3):
 * parsePropertyTypesJson は zod で 1 エントリずつ検証し、妥当なものだけ採用、
 * 妥当でないものは黙って捨ててヒューリスティックにフォールバックする。
 */
import { z } from 'zod';
import { isDateLike } from './frontmatter.js';

/** 内蔵の意味型。ファイルには書かれない (表示層のみ)。 */
export const BUILTIN_PROPERTY_TYPES = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multi-select',
  'tags',
  'star',
  'progress',
  'url',
  'note-link',
] as const;
export type BuiltinPropertyType = (typeof BUILTIN_PROPERTY_TYPES)[number];

/** select / multi-select の選択肢の色。 */
export const SELECT_COLORS = ['green', 'blue', 'amber', 'purple', 'red', 'gray'] as const;
export type SelectColor = (typeof SELECT_COLORS)[number];

/** select / multi-select の 1 選択肢 (色は任意)。 */
export interface SelectOption {
  value: string;
  color?: SelectColor;
}

/** キーに紐づく型定義 (JSON定義または内蔵解決結果の共通形)。 */
export interface PropertyTypeDef {
  type: BuiltinPropertyType;
  options?: SelectOption[];
}

/** 解決結果 — 内蔵ヒューリスティックか JSON定義かの由来を保持する。 */
export interface ResolvedPropertyType {
  type: BuiltinPropertyType;
  source: 'builtin' | 'json';
  options?: SelectOption[];
}

/** star の最大値 (0〜5)。 */
export const STAR_MAX = 5;

// ---- zod スキーマ (.loamium/property-types.json の検証) ----------------------

const builtinTypeSchema = z.enum(BUILTIN_PROPERTY_TYPES);
const selectColorSchema = z.enum(SELECT_COLORS);
const selectOptionSchema = z.union([
  z.string(),
  z.object({ value: z.string(), color: selectColorSchema.optional() }),
]);
/** 1 キー分の型定義スキーマ (options は string | {value,color} の混在を許容)。 */
export const propertyTypeDefSchema = z.object({
  type: builtinTypeSchema,
  options: z.array(selectOptionSchema).optional(),
});

function normalizeOptions(
  opts: ReadonlyArray<string | { value: string; color?: SelectColor | undefined }> | undefined,
): SelectOption[] | undefined {
  if (opts === undefined) return undefined;
  return opts.map((o) => {
    if (typeof o === 'string') return { value: o };
    const out: SelectOption = { value: o.value };
    if (o.color !== undefined) out.color = o.color;
    return out;
  });
}

/**
 * `.loamium/property-types.json` の生 JSON を検証済みの「キー → 型定義」へ変換する。
 * トップレベルがオブジェクトでなければ {} (フォールバック)。個々のエントリは
 * zod で検証し、妥当なものだけ採用する (壊れた 1 件で全体を諦めない — AC-2-3)。
 */
export function parsePropertyTypesJson(raw: unknown): Record<string, PropertyTypeDef> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PropertyTypeDef> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = propertyTypeDefSchema.safeParse(val);
    if (!parsed.success) continue;
    const def: PropertyTypeDef = { type: parsed.data.type };
    const options = normalizeOptions(parsed.data.options);
    if (options !== undefined) def.options = options;
    out[key] = def;
  }
  return out;
}

// ---- ヒューリスティック解決 --------------------------------------------------

const STAR_KEYS = new Set(['rating', 'score', 'stars', '評価']);
const SELECT_KEYS = new Set(['status', 'state', 'ステータス', '状態']);
const DATE_KEYS = new Set([
  'created',
  'updated',
  'modified',
  'due',
  'date',
  'published',
  '作成日',
  '更新日',
]);
const PROGRESS_KEYS = new Set(['progress', 'percent', 'percentage', '進捗', '進捗率']);
const TAGS_KEYS = new Set(['tags', 'aliases', 'tag', 'aliase']);
const URL_KEYS = new Set(['url', 'link', 'website', 'homepage', 'href', 'source']);

const NOTE_LINK_RE = /^\[\[.+\]\]$/;
const URL_LIKE_RE = /^https?:\/\/\S+$/i;

/** 値の JSON 的な型 (frontmatter のスカラー / 配列) に対する内蔵推定の入力。 */
export type PropertyValue = string | number | boolean | null | ReadonlyArray<unknown>;

/**
 * キー名 + 値の形から意味型を推定する (JSON定義が無いときのフォールバック)。
 * キー名は NFC 正規化 + lowercase で照合する (DESIGN_PRINCIPLES: 比較は NFC)。
 */
export function heuristicType(key: string, value: PropertyValue): BuiltinPropertyType {
  const k = key.normalize('NFC').trim().toLowerCase();

  // キー名ベース (最優先。値が空でも型が決まる)
  if (TAGS_KEYS.has(k)) return 'tags';
  if (STAR_KEYS.has(k)) return 'star';
  if (SELECT_KEYS.has(k)) return 'select';
  if (PROGRESS_KEYS.has(k)) return 'progress';
  if (DATE_KEYS.has(k)) return 'date';
  if (URL_KEYS.has(k)) return 'url';

  // 値ベース
  if (Array.isArray(value)) return 'tags';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'string') {
    if (NOTE_LINK_RE.test(value.trim())) return 'note-link';
    if (URL_LIKE_RE.test(value.trim())) return 'url';
    if (isDateLike(value)) return 'date';
    return 'text';
  }
  if (typeof value === 'number') return 'number';
  return 'text';
}

/**
 * キーの意味型を解決する。JSON定義 (defs[key]) があれば由来 'json' で上書き、
 * 無ければヒューリスティックを 'builtin' として返す (AC-2-1)。
 */
export function resolvePropertyType(
  key: string,
  value: PropertyValue,
  defs: Record<string, PropertyTypeDef>,
): ResolvedPropertyType {
  const d = defs[key];
  if (d !== undefined) {
    const res: ResolvedPropertyType = { type: d.type, source: 'json' };
    if (d.options !== undefined) res.options = d.options;
    return res;
  }
  return { type: heuristicType(key, value), source: 'builtin' };
}

// ---- 型ピッカー用メタ (内蔵型の説明・検索語) --------------------------------

/** 型ピッカーの 1 内蔵型項目 (説明・インクリメンタル絞り込み用の検索語)。 */
export interface BuiltinTypeMeta {
  type: BuiltinPropertyType;
  desc: string;
  /** 絞り込み対象の語 (型名 + 別名。空白区切り、lowercase 照合)。 */
  search: string;
}

/** 内蔵型の一覧 (prototype/props-redesign/chosen.html の型ピッカー準拠)。 */
export const BUILTIN_TYPE_META: readonly BuiltinTypeMeta[] = [
  { type: 'text', desc: '素のテキスト', search: 'text テキスト 文字 字列' },
  { type: 'number', desc: '数値', search: 'number 数値 数字 num' },
  { type: 'date', desc: '日付', search: 'date 日付 カレンダー calendar' },
  { type: 'checkbox', desc: '真偽(☑)', search: 'checkbox 真偽 boolean bool チェック' },
  { type: 'select', desc: '単一選択(色付き)', search: 'select 選択 単一 選択肢 プルダウン' },
  { type: 'multi-select', desc: '複数選択', search: 'multi-select multiselect 複数選択 select' },
  { type: 'tags', desc: '# で候補・複数チップ', search: 'tags タグ # チップ' },
  { type: 'star', desc: '0〜5 星', search: 'star 星 評価 rating レーティング' },
  { type: 'progress', desc: '0-100% バー', search: 'progress 進捗 パーセント percent bar' },
  { type: 'url', desc: 'リンク', search: 'url link リンク http web' },
  { type: 'note-link', desc: '[[note]] 型', search: 'note-link ノートリンク wikilink 関連' },
];

/** 型ピッカーの 1 候補 (内蔵 + JSON定義の統一表現)。 */
export interface TypePickerOption {
  /** 内蔵型は型名、JSON定義型はキー名 (= data-type)。 */
  name: string;
  type: BuiltinPropertyType;
  source: 'builtin' | 'json';
  desc: string;
  search: string;
  options?: SelectOption[];
}

/** JSON定義型の説明文 (select は選択肢を、その他は型名を要約表示)。 */
function jsonDefDesc(def: PropertyTypeDef): string {
  if (
    (def.type === 'select' || def.type === 'multi-select') &&
    def.options !== undefined &&
    def.options.length > 0
  ) {
    return `${def.type}: ${def.options.map((o) => o.value).join(' / ')}`;
  }
  return def.type;
}

/**
 * 型ピッカーに並べる候補 (内蔵型 + JSON定義型) を生成する。
 * JSON定義型は各キーを「そのキー名の型」として提示する (source='json')。
 */
export function buildTypePickerOptions(
  defs: Record<string, PropertyTypeDef>,
): { builtin: TypePickerOption[]; json: TypePickerOption[] } {
  const builtin: TypePickerOption[] = BUILTIN_TYPE_META.map((m) => ({
    name: m.type,
    type: m.type,
    source: 'builtin' as const,
    desc: m.desc,
    search: m.search,
  }));
  const json: TypePickerOption[] = Object.entries(defs).map(([key, def]) => {
    const opt: TypePickerOption = {
      name: key,
      type: def.type,
      source: 'json' as const,
      desc: jsonDefDesc(def),
      search: `${key} ${def.type} ${(def.options ?? []).map((o) => o.value).join(' ')}`,
    };
    if (def.options !== undefined) opt.options = def.options;
    return opt;
  });
  return { builtin, json };
}

/** 型ピッカーの候補を絞り込み語で filter する (lowercase 部分一致 — AC-3-1)。 */
export function filterTypeOptions(options: TypePickerOption[], query: string): TypePickerOption[] {
  const q = query.normalize('NFC').trim().toLowerCase();
  if (q === '') return options;
  return options.filter(
    (o) => o.search.toLowerCase().includes(q) || o.name.toLowerCase().includes(q),
  );
}

// ---- キーファースト追加 (Sd13ab1-2) -----------------------------------------

/**
 * 「既知/一意」プロパティのキー(内蔵 well-known)。追加メニュー zone ① の初期候補。
 * 型は D方式(キーから決まる)と一致させる — heuristicType と矛盾しないよう選ぶ。
 * これらは一意(1 文書に 1 つ)を意図するキー。
 */
export interface WellKnownKeyMeta {
  key: string;
  type: BuiltinPropertyType;
  desc: string;
  /** 絞り込み対象の語 (空白区切り、lowercase 照合)。 */
  search: string;
}

export const WELL_KNOWN_KEYS: readonly WellKnownKeyMeta[] = [
  { key: 'tags', type: 'tags', desc: 'タグ(複数) — 一意', search: 'tags タグ' },
  { key: 'aliases', type: 'tags', desc: '別名リスト(複数) — 一意', search: 'aliases エイリアス 別名 alias' },
  {
    key: 'cssclasses',
    type: 'tags',
    desc: 'CSS クラス(複数) — 一意',
    search: 'cssclasses css class クラス スタイル',
  },
  { key: 'status', type: 'select', desc: 'select(単一) — 一意', search: 'status ステータス 状態' },
  { key: 'rating', type: 'star', desc: '0〜5 星', search: 'rating 評価 star 星' },
  { key: 'created', type: 'date', desc: '作成日', search: 'created 作成日 date 日付' },
  { key: 'due', type: 'date', desc: '期限', search: 'due 期限 締切 date 日付' },
  { key: 'progress', type: 'progress', desc: '進捗 0-100%', search: 'progress 進捗 percent パーセント' },
  { key: 'url', type: 'url', desc: 'リンク', search: 'url link リンク web http' },
];

/** vault 内で実際に使われている frontmatter キーの件数 (GET /api/property-keys)。 */
export interface PropertyKeyCount {
  key: string;
  count: number;
}

/** キーファースト追加メニューの 1 候補(zone ① 既知/一意)。 */
export interface KeyOption {
  /** プロパティ名 (= data-key)。 */
  key: string;
  /** D方式で解決した意味型 (アイコン表示用)。 */
  type: BuiltinPropertyType;
  /** 由来: 内蔵 well-known / JSON定義 / vault 内の実使用キー。 */
  source: 'builtin' | 'json' | 'vault';
  desc: string;
  search: string;
  /** vault 内の使用件数 (source='vault' または vault にも存在するとき)。 */
  count?: number;
  /** この文書に既に存在する = 一意なので追加不可 (淡色無効)。 */
  existing: boolean;
}

/**
 * キーファースト追加メニューの候補 (zone ① 既知/一意) を生成する。
 * 内蔵 well-known + `.loamium/property-types.json` 定義キー + vault 内実使用キー
 * (件数付き) をキーで重複排除して 1 覧にする。この文書に既にあるキーは existing=true
 * (追加不可)。型は D方式(resolvePropertyType)で解決してアイコンに使う。
 *
 * 並び順: 内蔵(定義順) → JSON定義(キー昇順) → vault のみ(件数降順→キー昇順)。
 */
export function buildKeyOptions(
  defs: Record<string, PropertyTypeDef>,
  vaultKeys: readonly PropertyKeyCount[],
  existingKeys: ReadonlySet<string>,
): KeyOption[] {
  const countByKey = new Map<string, number>();
  for (const v of vaultKeys) countByKey.set(v.key, v.count);

  const order = new Map<string, KeyOption>();
  const add = (o: KeyOption): void => {
    const cur = order.get(o.key);
    if (cur === undefined) {
      order.set(o.key, o);
    } else if (cur.count === undefined && o.count !== undefined) {
      cur.count = o.count;
    }
  };

  // 内蔵 well-known (定義順)
  for (const w of WELL_KNOWN_KEYS) {
    const type = resolvePropertyType(w.key, null, defs).type;
    const opt: KeyOption = {
      key: w.key,
      type,
      source: defs[w.key] !== undefined ? 'json' : 'builtin',
      desc: w.desc,
      search: w.search,
      existing: existingKeys.has(w.key),
    };
    const c = countByKey.get(w.key);
    if (c !== undefined) opt.count = c;
    add(opt);
  }

  // JSON定義キー (キー昇順)
  for (const key of Object.keys(defs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const def = defs[key];
    if (def === undefined) continue;
    const opt: KeyOption = {
      key,
      type: def.type,
      source: 'json',
      desc: jsonDefDesc(def),
      search: `${key} ${def.type} ${(def.options ?? []).map((o) => o.value).join(' ')}`,
      existing: existingKeys.has(key),
    };
    const c = countByKey.get(key);
    if (c !== undefined) opt.count = c;
    add(opt);
  }

  // vault 内で実際に使われているキー (件数降順→キー昇順)
  const sortedVault = [...vaultKeys].sort((a, b) =>
    a.count !== b.count ? b.count - a.count : a.key < b.key ? -1 : 1,
  );
  for (const v of sortedVault) {
    const cur = order.get(v.key);
    if (cur !== undefined) {
      if (cur.count === undefined) cur.count = v.count;
      continue;
    }
    add({
      key: v.key,
      type: resolvePropertyType(v.key, null, defs).type,
      source: 'vault',
      desc: `vault で ${v.count} 件`,
      search: v.key,
      count: v.count,
      existing: existingKeys.has(v.key),
    });
  }

  return [...order.values()];
}

/** キー候補を絞り込み語で filter する (key + search の lowercase 部分一致)。 */
export function filterKeyOptions(options: KeyOption[], query: string): KeyOption[] {
  const q = query.normalize('NFC').trim().toLowerCase();
  if (q === '') return options;
  return options.filter(
    (o) => o.key.toLowerCase().includes(q) || o.search.toLowerCase().includes(q),
  );
}

/**
 * 入力名が「新規作成」候補として妥当か。既存の候補キー(大小無視)と完全一致する
 * なら新規作成は出さない (それは zone ① で選ぶ)。空も不可。
 */
export function canCreateNewKey(name: string, options: KeyOption[]): boolean {
  const t = name.normalize('NFC').trim();
  if (t === '') return false;
  const lower = t.toLowerCase();
  return !options.some((o) => o.key.toLowerCase() === lower);
}

/** 型に応じた「新規プロパティの初期値」(標準 YAML スカラー) を返す。
 * star/number/progress→0, checkbox→false, tags/multi-select→[], それ以外→'' (空文字)。
 */
export function defaultValueForType(type: BuiltinPropertyType): string | number | boolean | [] {
  switch (type) {
    case 'star':
    case 'number':
    case 'progress':
      return 0;
    case 'checkbox':
      return false;
    case 'tags':
    case 'multi-select':
      return [];
    default:
      return '';
  }
}

/** 0〜STAR_MAX にクランプした整数 (star 値の正規化)。 */
export function clampStar(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(STAR_MAX, Math.round(n)));
}

/** 0〜100 にクランプした整数 (progress 値の正規化)。 */
export function clampProgress(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** value(文字列)から select の色を安定に決める (options に色指定が無い場合)。 */
export function selectColorFor(value: string, options?: SelectOption[]): SelectColor {
  if (options !== undefined) {
    const hit = options.find((o) => o.value === value);
    if (hit?.color !== undefined) return hit.color;
  }
  // 値のハッシュから安定に色を割り当てる (gray は最後の予備)
  const palette = SELECT_COLORS.filter((c) => c !== 'gray');
  let h = 0;
  for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length] ?? 'gray';
}
