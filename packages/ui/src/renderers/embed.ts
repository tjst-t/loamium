/**
 * ![[embed]] transclusion レンダラー (S9e5ca4-1) と画像埋め込み (S9e5ca4-2)。
 *
 * - ![[note]]        単独行 → 読み取り専用カード (embed-card)。ヘッダクリックで元ノートへ
 * - ![[note#見出し]]  該当セクションのみ (shared の extractSection)
 * - ![[image.png]]   画像 (embed-image、GET /api/files/{path})
 * - 循環 (A→B→A) と深さ超過は embed-error カードで安全に打ち切る (AC-S9e5ca4-1-3)
 *
 * 拡張子 → プレビュー種別のディスパッチはレジストリ (registerEmbedFileRenderer)。
 * 新しいファイル種別 (PDF・テキスト等) は登録だけで追加できる (3 レジストリと同じ流儀)。
 * すべて表示層のみ — ファイル (ピュア Markdown) は一切変更しない (priority 1)。
 */
import { extractSection, resolveLinkTarget } from '@loamium/shared';
import { api } from '../api.js';
import { registerBlockRule, type RenderContext } from '../registries.js';
import { EMBED_LINE_RE, renderMarkdownInto } from './mini-md.js';

/** embed チェーンの最大深さ (ルートノートを含む)。prototype の注記と一致。 */
export const MAX_EMBED_DEPTH = 5;

// ---- 純粋ロジック (ユニットテスト対象) ----------------------------------------

export interface EmbedTarget {
  /** # より前 (NFC 正規化・trim 済み) */
  target: string;
  /** #見出し 部分 (無ければ null)。^block 参照は対象外 (読み取り互換のみ) */
  section: string | null;
}

/** ![[target#見出し]] の中身を分解する。 */
export function parseEmbedTarget(raw: string): EmbedTarget {
  const nfc = raw.normalize('NFC').trim();
  const hash = nfc.indexOf('#');
  if (hash === -1) return { target: nfc, section: null };
  const target = nfc.slice(0, hash).trim();
  const sub = nfc.slice(hash + 1).trim();
  // ^block 参照は見出しセクションではない (生成もしない — VISION out_of_scope)
  const section = sub.length > 0 && !sub.startsWith('^') ? sub : null;
  return { target, section };
}

/** ターゲットの拡張子 (小文字)。ノート (.md / 拡張子なし) は null。 */
export function embedExtensionOf(target: string): string | null {
  const base = target.split('/').pop() ?? target;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext === 'md' || !/^[a-z0-9]+$/.test(ext)) return null;
  return ext;
}

export type EmbedGuardResult =
  | { ok: true }
  | { ok: false; reason: 'cycle' | 'depth'; chain: readonly string[] };

/**
 * embed チェーンの安全判定 (AC-S9e5ca4-1-3)。
 * - 解決先がチェーンに既出 → 循環 (cycle)
 * - チェーンが最大深さに達している → 深さ超過 (depth)
 */
export function checkEmbedChain(chain: readonly string[], resolved: string): EmbedGuardResult {
  if (chain.includes(resolved)) {
    return { ok: false, reason: 'cycle', chain: [...chain, resolved] };
  }
  if (chain.length >= MAX_EMBED_DEPTH) {
    return { ok: false, reason: 'depth', chain: [...chain, resolved] };
  }
  return { ok: true };
}

// ---- 拡張子 → プレビュー種別のレジストリ ---------------------------------------

export interface EmbedFileRenderer {
  /** 小文字の拡張子 (ドットなし) */
  extensions: readonly string[];
  render(path: string, alt: string, ctx: RenderContext): HTMLElement;
}

const fileRenderers = new Map<string, EmbedFileRenderer>();

/** ファイル種別レンダラーを登録する (PDF・テキスト等の追加はここに乗せる)。 */
export function registerEmbedFileRenderer(renderer: EmbedFileRenderer): void {
  for (const ext of renderer.extensions) {
    fileRenderers.set(ext.toLowerCase(), renderer);
  }
}

export function getEmbedFileRenderer(ext: string): EmbedFileRenderer | undefined {
  return fileRenderers.get(ext.toLowerCase());
}

export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'bmp',
  'ico',
] as const;

// ---- DOM 構築 -----------------------------------------------------------------

function encodeFilesUrl(rel: string): string {
  return `/api/files/${rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`;
}

/** ノートタイトル表示 (basename から .md を除く)。 */
function titleOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

const NOTE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="embed-ico"><path d="M4 1.8h5.2L12.2 4.8v9.4H4z"/><path d="M9.2 1.8v3h3"/></svg>';
const OPEN_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="open-ico"><path d="M6 3h7v7M13 3L7 9"/><path d="M11 9v4H3V5h4" opacity="0.5"/></svg>';
const ERROR_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="embed-ico"><circle cx="8" cy="8" r="6.2"/><path d="M8 5v3.6M8 11h.01"/></svg>';

/** 固定 SVG 文字列 (上の定数のみ) をアイコン要素にする。 */
function icon(svg: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'embed-ico-wrap';
  span.innerHTML = svg; // 定数リテラルのみ (vault 由来の文字列は通さない)
  return span;
}

/** 循環・深さ超過・壊れ embed のエラーカード (data-testid=embed-error)。 */
export function renderEmbedError(dataTarget: string, title: string, detail: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'embed-card error';
  card.setAttribute('data-testid', 'embed-error');
  card.setAttribute('data-target', dataTarget);
  const header = document.createElement('div');
  header.className = 'embed-header';
  header.append(icon(ERROR_ICON), document.createTextNode(title));
  const body = document.createElement('div');
  body.className = 'embed-error-body';
  const code = document.createElement('code');
  code.textContent = detail;
  body.append(code);
  card.append(header, body);
  return card;
}

/** 画像埋め込み (embed-image)。![[img.png]] と ![](path) の両方が使う。 */
export function renderImageEmbed(pathOrUrl: string, alt: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'embed-image-wrap';
  wrap.setAttribute('data-testid', 'embed-image');
  wrap.setAttribute('data-path', pathOrUrl);
  const caption = document.createElement('span');
  caption.className = 'embed-image-caption';
  caption.textContent = pathOrUrl;
  const img = document.createElement('img');
  const external = /^https?:\/\//.test(pathOrUrl);
  img.src = external ? pathOrUrl : encodeFilesUrl(pathOrUrl);
  img.alt = alt.length > 0 ? alt : pathOrUrl;
  img.addEventListener('error', () => {
    wrap.setAttribute('data-error', 'true');
    caption.textContent = `画像を読み込めませんでした — ${pathOrUrl}`;
  });
  wrap.append(img, caption);
  return wrap;
}

const imageRenderer: EmbedFileRenderer = {
  extensions: IMAGE_EXTENSIONS,
  render: (path, alt) => renderImageEmbed(path, alt),
};

/**
 * ![[rawTarget]] を描画する。ネストした embed から再帰的にも呼ばれる
 * (ctx.embedChain で循環・深さを判定する)。
 */
export function renderEmbed(rawTarget: string, ctx: RenderContext): HTMLElement {
  const { target, section } = parseEmbedTarget(rawTarget);
  const chain = ctx.embedChain ?? [ctx.notePath];

  if (target.length === 0) {
    return renderEmbedError(rawTarget, '埋め込み先を解決できません', `![[${rawTarget}]]`);
  }

  // 画像などファイル種別のディスパッチ (vault ルート相対 — 添付は assets/ 慣行)
  const ext = embedExtensionOf(target);
  if (ext !== null) {
    const renderer = getEmbedFileRenderer(ext);
    if (renderer !== undefined) return renderer.render(target, section ?? '', ctx);
    return renderEmbedError(target, 'このファイル形式の埋め込みプレビューには未対応です', `![[${rawTarget}]]`);
  }

  // ノート embed: 既存リンク解決 (shared) を再利用
  const paths = ctx.env?.getNotePaths() ?? null;
  if (paths === null) {
    // 一覧未ロード: 壊れ扱いにしない (wikilink と同じ規約)。一覧が届くと再描画される
    const card = document.createElement('div');
    card.className = 'embed-card';
    card.setAttribute('data-testid', 'embed-card');
    card.setAttribute('data-target', target);
    const body = document.createElement('div');
    body.className = 'embed-body loading';
    body.textContent = '読み込み中…';
    card.append(body);
    return card;
  }
  const resolved = resolveLinkTarget(target, paths);
  if (resolved === null) {
    return renderEmbedError(
      /\.md$/i.test(target) ? target : `${target}.md`,
      'ノートが見つかりません',
      `![[${rawTarget}]]`,
    );
  }

  // 循環・深さ制限 (AC-S9e5ca4-1-3): フリーズ・クラッシュさせず打ち切る
  const guard = checkEmbedChain(chain, resolved);
  if (guard.ok === false) {
    const chainText = guard.chain.map(titleOf).join(' → ');
    return guard.reason === 'cycle'
      ? renderEmbedError(resolved, '循環埋め込みを検出しました', chainText)
      : renderEmbedError(resolved, `埋め込みが深すぎます (最大深さ ${String(MAX_EMBED_DEPTH)})`, chainText);
  }

  const card = document.createElement('div');
  card.className = 'embed-card';
  card.setAttribute('data-testid', 'embed-card');
  card.setAttribute('data-target', resolved);
  if (section !== null) card.setAttribute('data-section', section);

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'embed-header';
  header.setAttribute('data-testid', 'embed-card-open');
  header.title = section === null ? '元ノートを開く' : '元ノートの該当見出しを開く';
  header.append(icon(NOTE_ICON), document.createTextNode(titleOf(resolved)));
  if (section !== null) {
    const chip = document.createElement('span');
    chip.className = 'section-chip';
    chip.textContent = `# ${section}`;
    header.append(chip);
  }
  header.append(icon(OPEN_ICON));
  // click ではなく mousedown: クリックでカーソルが行へ入ると装飾がソース表示に
  // 差し替わり click が届かない (WikilinkWidget と同じ理由)
  header.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.env?.openNote(resolved);
  });
  // click はカード全体の「ソース編集へ戻る」リスナー (BlockRuleWidget) に
  // 届かせない — ヘッダはナビゲーション専用
  header.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  const body = document.createElement('div');
  body.className = 'embed-body';
  body.textContent = '読み込み中…';
  card.append(header, body);

  const nestedChain = [...chain, resolved];
  void api.getNote(resolved).then(
    (note) => {
      const md = section === null ? note.body : extractSection(note.body, section);
      body.textContent = '';
      if (md === null) {
        body.classList.add('embed-body-error');
        body.textContent = `見出しが見つかりません: # ${section ?? ''}`;
        return;
      }
      renderMarkdownInto(body, md, {
        env: ctx.env,
        onEmbedLine: (nested) =>
          renderEmbed(nested, { ...ctx, embedChain: nestedChain }),
        onImage: renderImageEmbed,
      });
    },
    (err: unknown) => {
      body.textContent = '';
      body.classList.add('embed-body-error');
      body.textContent = `埋め込み先を読み込めませんでした — ${
        err instanceof Error ? err.message : String(err)
      }`;
    },
  );

  return card;
}

/** embed ブロックルールを登録する (renderers/index.ts から呼ぶ)。 */
export function registerEmbedRenderers(): void {
  registerEmbedFileRenderer(imageRenderer);
  registerBlockRule({
    match: (line) => EMBED_LINE_RE.test(line),
    identity(lines, ctx) {
      // リンク解決の状態 (未ロード / 壊れ / 解決先) が変わったら再描画する
      const m = EMBED_LINE_RE.exec(lines[0] ?? '');
      const { target } = parseEmbedTarget(m?.[1] ?? '');
      if (embedExtensionOf(target) !== null) return `file:${target}`;
      const paths = ctx.env?.getNotePaths() ?? null;
      if (paths === null) return 'unloaded';
      return resolveLinkTarget(target, paths) ?? 'broken';
    },
    render(lines, ctx) {
      const m = EMBED_LINE_RE.exec(lines[0] ?? '');
      return renderEmbed(m?.[1] ?? '', ctx);
    },
  });
}
