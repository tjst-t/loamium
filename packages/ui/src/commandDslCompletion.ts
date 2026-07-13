/**
 * CodeMirror 6 補完ソース — スマートコマンド DSL v2 (ADR-0023)。
 *
 * 3 つのソースを提供する:
 *   1. kindCompletionSource   — "kind: " の直後に 6 種の kind 候補 + フィールド雛形
 *   2. tokenCompletionSource  — "{{" の直後に param 名・date:/now: トークン・|fallback
 *   3. fieldValueCompletionSource — position:/section:/type:/(target:) の値補完
 *
 * ノートパス補完 (target:) はマウント時に GET /api/notes を 1 回フェッチしてキャッシュ。
 * フェッチ失敗 → 補完なし (フォールバック)。
 * section: 補完は静的ヒントのみ (Todo/Done/Notes/Tasks 等)。
 *
 * [AC-S9e64e7-3-1] kind 補完 + scaffold
 * [AC-S9e64e7-3-2] {{ トークン補完 + type/position/section/target 補完
 * [AC-S9e64e7-3-3] 単体テスト可能な公開 CompletionSource 関数群
 */
import {
  autocompletion,
  insertCompletionText,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import {
  commandParamTypeSchema,
  insertPositionSchema,
  commandStepSchema,
} from '@loamium/shared';

// ---- DSL 語彙定数 (shared スキーマから派生させる) ---------------------------

/**
 * DSL v2 の 6 種 step kind。
 * commandStepSchema の discriminatedUnion から種別一覧を取得する (ハードコードしない)。
 */
export const DSL_KINDS: readonly string[] = (() => {
  // z.discriminatedUnion の optionsMap から key を抜く (安定 API)。
  // optionsMap は Map<discriminator-value, ZodObject> 型。
  const map = commandStepSchema.optionsMap as Map<string, unknown>;
  return Array.from(map.keys());
})();

/**
 * CommandParam の type 値一覧 (commandParamTypeSchema.options)。
 */
export const DSL_PARAM_TYPES: readonly string[] = commandParamTypeSchema.options;

/**
 * position: フィールドの有効値 (insertPositionSchema.options)。
 */
export const DSL_POSITIONS: readonly string[] = insertPositionSchema.options;

/**
 * section: フィールドの静的ヒント。
 * "入力しやすさ" のため代表的な見出し名を提示 (自由入力を妨げない)。
 */
export const STATIC_SECTION_HINTS: readonly string[] = [
  'Todo',
  'Done',
  'Notes',
  'Tasks',
  'Log',
  'Journal',
  'Ideas',
  'Archive',
];

// ---- フィールド雛形 (kind → YAML スニペット) --------------------------------

/**
 * kind を選択したときに挿入する YAML スニペット。
 * 呼び出し側が既存行の "kind: xxx" を置き換えた直後の位置に挿入する。
 * 各 kind のフィールド仕様を DSL スキーマから把握した上で手動定義:
 *   journal-append:  content(必須), date?, section?, position?, open?, when?, when-not?
 *   note-append:     target(必須), content(必須), section?, create?, position?, open?, when?, when-not?
 *   note-create:     target(必須), content(必須), open?, when?, when-not?
 *   template-inst.:  template(必須), vars?, open?, when?, when-not?
 *   prop-set:        target(必須), set?, unset?, when?, when-not?
 *   note-patch:      target(必須), old(必須), new(必須), when?, when-not?
 *
 * インデントは 4 スペース (YAML frontmatter 内 steps[].* の標準)。
 * 省略可フィールドはコメントアウト形式で記述し、ユーザーが削除して使える。
 */
const KIND_SCAFFOLDS: Record<string, string> = {
  'journal-append': [
    '      content: ""',
    '      # date: "{{date:YYYY-MM-DD}}"',
    '      # section: Todo',
    '      # position: bottom',
  ].join('\n'),

  'note-append': [
    '      target: ""',
    '      content: ""',
    '      # section: Todo',
    '      # create: false',
    '      # position: bottom',
  ].join('\n'),

  'note-create': [
    '      target: ""',
    '      content: ""',
  ].join('\n'),

  'template-instantiate': [
    '      template: ""',
    '      # vars:',
    '      #   key: value',
  ].join('\n'),

  'prop-set': [
    '      target: ""',
    '      # set:',
    '      #   key: value',
    '      # unset: []',
  ].join('\n'),

  'note-patch': [
    '      target: ""',
    '      old: ""',
    '      new: ""',
  ].join('\n'),
};

// ---- 1. kind 補完ソース ------------------------------------------------------

/** "kind: <cursor>" パターンを検出する正規表現。 */
const KIND_RE = /^\s*-?\s*kind:\s+(\w[\w-]*)?\s*$/;
/** kind: フィールドの後ろにカーソルがある行を検出する。 */
const KIND_TRIGGER_RE = /^\s*-?\s*kind:\s+([\w-]*)$/;

/**
 * kind: 行の末尾でトリガーし、6 種の候補と scaffold を挿入する。
 * [AC-S9e64e7-3-1]
 */
export function kindCompletionSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const text = line.text.slice(0, context.pos - line.from);
  const m = KIND_TRIGGER_RE.exec(text);
  if (m === null) return null;

  const query = m[1] ?? '';
  const from = context.pos - query.length;

  const options: Completion[] = DSL_KINDS.map((kind) => {
    const scaffold = KIND_SCAFFOLDS[kind];
    return {
      label: kind,
      type: 'keyword',
      apply: (view, _completion, applyFrom, applyTo) => {
        // 1. まず kind の値部分を置き換える。
        let insert = kind;
        if (scaffold !== undefined) {
          insert += '\n' + scaffold;
        }
        view.dispatch(insertCompletionText(view.state, insert, applyFrom, applyTo));
      },
    };
  });

  // query で前方一致絞り込み (大文字小文字区別なし)
  const q = query.toLowerCase();
  const filtered = q.length === 0 ? options : options.filter((o) => o.label.startsWith(q));

  if (filtered.length === 0) return null;

  return {
    from,
    options: filtered,
    filter: false,
  };
}

// ---- 2. {{ トークン補完ソース -----------------------------------------------

/**
 * カーソル前の "{{" 以降の未クローズトークンを検出する。
 * "{{param" → { from: "{{" の直後, query: "param" }
 */
const TOKEN_TRIGGER_RE = /\{\{([\w:-]*)$/;

/**
 * ドキュメント全体から `params:` セクションの `- name:` フィールドを簡易抽出する。
 * YAML フルパーサは重すぎるため、正規表現による近似 (十分な精度)。
 *
 * マッチするパターン:
 *   "    - name: foo"  (params リストアイテム: ハイフン + name:)
 * マッチしないパターン:
 *   "  name: foo"  (loamium-command.name などトップレベルフィールド、ハイフンなし)
 * これにより steps[].name や loamium-command.name を除外し、params のみ抽出する。
 */
export function extractParamNames(doc: string): string[] {
  const names: string[] = [];
  // リストアイテム形式の "- name: <value>" のみを対象にする。
  // インデント (スペース1個以上) + "- " + "name:" + 値。
  // 値は引用符なし/シングル/ダブル引用符を許容。
  const lines = doc.split('\n');
  for (const line of lines) {
    const m = /^\s+-\s+name:\s+["']?([a-zA-Z_][\w-]*)["']?\s*$/.exec(line);
    if (m !== null) {
      const name = m[1];
      if (name !== undefined && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * {{ の直後でトリガーし、param 名・date:/now: トークン・|fallback を補完する。
 * [AC-S9e64e7-3-2]
 */
export function tokenCompletionSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const text = line.text.slice(0, context.pos - line.from);
  const m = TOKEN_TRIGGER_RE.exec(text);
  if (m === null) return null;

  const query = m[1] ?? '';
  const from = context.pos - query.length;

  const doc = context.state.doc.toString();
  const paramNames = extractParamNames(doc);

  const options: Completion[] = [];

  // param 名候補 (宣言済みのみ — ライブ更新)
  for (const name of paramNames) {
    options.push({
      label: name,
      type: 'variable',
      detail: 'param',
      apply: (view, _completion, applyFrom, applyTo) => {
        view.dispatch(insertCompletionText(view.state, `${name}}}`, applyFrom, applyTo));
      },
    });
  }

  // date: トークン
  options.push({
    label: 'date:YYYY-MM-DD',
    type: 'constant',
    detail: '日付トークン',
    apply: (view, _completion, applyFrom, applyTo) => {
      view.dispatch(insertCompletionText(view.state, 'date:YYYY-MM-DD}}', applyFrom, applyTo));
    },
  });

  // now: トークン
  options.push({
    label: 'now:HH:mm',
    type: 'constant',
    detail: '現在時刻トークン',
    apply: (view, _completion, applyFrom, applyTo) => {
      view.dispatch(insertCompletionText(view.state, 'now:HH:mm}}', applyFrom, applyTo));
    },
  });

  // |fallback ヒント
  options.push({
    label: '|fallback',
    type: 'text',
    detail: 'フォールバック値 (例: {{param|デフォルト}})',
    apply: (view, _completion, applyFrom, applyTo) => {
      view.dispatch(insertCompletionText(view.state, '|', applyFrom, applyTo));
    },
  });

  // query で前方一致絞り込み
  const q = query.toLowerCase();
  const filtered = q.length === 0 ? options : options.filter((o) =>
    o.label.toLowerCase().startsWith(q)
  );

  if (filtered.length === 0) return null;

  return {
    from,
    options: filtered,
    filter: false,
  };
}

// ---- 3. フィールド値補完ソース (position/section/type/target) ----------------

/** フィールドキー + 値位置を検出する正規表現群。 */
const FIELD_RE: Record<string, RegExp> = {
  position: /^\s+position:\s+([\w]*)$/,
  section:  /^\s+section:\s+([\S]*)$/,
  type:     /^\s+type:\s+([\w]*)$/,
  target:   /^\s+target:\s+([\S]*)$/,
};

/**
 * position:/section:/type:/target: フィールドの値を補完する。
 * [AC-S9e64e7-3-2]
 *
 * @param notePaths vault ノートパス一覧 (null = 未ロード。target: 補完は提供しない)
 */
export function fieldValueCompletionSource(
  notePaths: readonly string[] | null,
): (context: CompletionContext) => CompletionResult | null {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const text = line.text.slice(0, context.pos - line.from);

    for (const [field, re] of Object.entries(FIELD_RE)) {
      const m = re.exec(text);
      if (m === null) continue;

      const query = m[1] ?? '';
      const from = context.pos - query.length;

      let candidates: string[] = [];

      switch (field) {
        case 'position':
          candidates = [...DSL_POSITIONS];
          break;
        case 'section':
          candidates = [...STATIC_SECTION_HINTS];
          break;
        case 'type':
          candidates = [...DSL_PARAM_TYPES];
          break;
        case 'target':
          candidates = notePaths !== null ? [...notePaths] : [];
          break;
        default:
          candidates = [];
      }

      const q = query.toLowerCase();
      const filtered = candidates.filter((c) =>
        q.length === 0 || c.toLowerCase().startsWith(q)
      );

      if (filtered.length === 0) return null;

      return {
        from,
        options: filtered.map((c) => ({
          label: c,
          type: field === 'target' ? 'file' : 'keyword',
        })),
        filter: false,
      };
    }

    return null;
  };
}

// ---- 統合 Extension ---------------------------------------------------------

/** ノートパス一覧のキャッシュ (CommandEditor ごとにモジュールスコープで保持)。 */
let cachedNotePaths: readonly string[] | null = null;
let noteFetchStarted = false;

/**
 * GET /api/notes を 1 回フェッチして notePaths をキャッシュする。
 * エラーの場合は空配列にフォールバックし、補完は提供しない。
 */
async function prefetchNotePaths(apiBase: string): Promise<void> {
  if (noteFetchStarted) return;
  noteFetchStarted = true;
  try {
    const res = await fetch(`${apiBase}/api/notes`);
    if (!res.ok) {
      cachedNotePaths = [];
      return;
    }
    const data = (await res.json()) as { notes?: Array<{ path: string }> };
    cachedNotePaths = (data.notes ?? []).map((n) => n.path);
  } catch {
    cachedNotePaths = [];
  }
}

/**
 * テスト用: キャッシュを外部から注入する。
 */
export function setCommandDslNotePaths(paths: readonly string[] | null): void {
  cachedNotePaths = paths;
  noteFetchStarted = paths !== null;
}

/**
 * CommandEditor の左ペイン CodeMirror に登録する補完 Extension。
 * - kind: 補完 + scaffold
 * - {{ トークン補完 (param 名 / date: / now: / |fallback)
 * - position:/section:/type:/target: フィールド値補完
 *
 * @param apiBase fetch のベース URL (既定 "")
 */
export function commandDslCompletionExtension(apiBase = ''): Extension {
  // マウント時に 1 回だけノートパスをフェッチ
  void prefetchNotePaths(apiBase);

  // cachedNotePaths を使う動的ラッパー (フェッチ完了後に反映)
  const dynamicFieldSource = (ctx: CompletionContext): CompletionResult | null =>
    fieldValueCompletionSource(cachedNotePaths)(ctx);

  return autocompletion({
    override: [
      kindCompletionSource,
      tokenCompletionSource,
      dynamicFieldSource,
    ],
    icons: false,
    activateOnTyping: true,
    defaultKeymap: true,
    selectOnOpen: true,
    // CodeMirror のデフォルト fuzzy フィルタを無効化 (各ソースが自前絞り込み)
  });
}
