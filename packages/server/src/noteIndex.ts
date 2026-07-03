/**
 * インメモリインデックス — 全文検索 (Fuse.js)・タグ・バックリンク。
 *
 * 原則 (DESIGN_PRINCIPLES priority 6): インデックスは使い捨て、ファイルが正。
 * 常にファイルシステムから再構築でき、壊れてもファイルは壊れない。
 * Fuse インスタンスは変更のたびに配列から再生成する (個人 vault 規模で十分軽い。
 * 数千ノートで遅くなったら SQLite FTS5 へ移行する — SPEC §9-9)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Fuse, { type IFuseOptions } from 'fuse.js';
import {
  extractLinks,
  extractTags,
  noteTitle,
  resolveLinkTarget,
  type BacklinkSource,
  type NoteMeta,
  type SearchResult,
  type TagCount,
  type WikiLink,
} from '@loamium/shared';
import { resolveVaultFile } from './vault.js';

export interface IndexedNote {
  /** vault 相対パス (NFC、"/" 区切り) */
  path: string;
  title: string;
  content: string;
  tags: string[];
  links: WikiLink[];
}

const FUSE_OPTIONS: IFuseOptions<IndexedNote> = {
  keys: [
    { name: 'title', weight: 2 },
    { name: 'path', weight: 1.5 },
    { name: 'content', weight: 1 },
  ],
  includeScore: true,
  includeMatches: true,
  ignoreLocation: true,
  threshold: 0.2,
  minMatchCharLength: 2,
};

/** relPath のどこかのセグメントがドット始まりか (.loamium / .git 等はインデックス対象外) */
function hasHiddenSegment(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg.startsWith('.'));
}

export class VaultIndex {
  private readonly notes = new Map<string, IndexedNote>();
  private fuse: Fuse<IndexedNote> | null = null;
  private fuseDirty = true;

  constructor(private readonly vaultRoot: string) {}

  /** vault を全走査してインデックスを構築する (起動時 / 再構築)。 */
  async build(): Promise<void> {
    this.notes.clear();
    this.fuseDirty = true;
    const root = path.resolve(this.vaultRoot);
    const walk = async (dirAbs: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return; // 消えたディレクトリ等は無視 (ファイルが正、次のイベントで追従)
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // .loamium / .git / .obsidian
        const abs = path.join(dirAbs, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const rel = path.relative(root, abs).split(path.sep).join('/').normalize('NFC');
          await this.refreshFile(rel, abs);
        }
      }
    };
    await walk(root);
  }

  /**
   * 1 ファイルを再読込してインデックスを更新する。
   * ファイルが存在しなければインデックスから取り除く (削除にも使える)。
   *
   * @param absPathHint ディスク上の実パス。NFD ファイル名 (macOS 由来) は NFC 正規化した
   *   相対パスと一致しないことがあるため、walk / watcher が見つけた実パスを優先して読む。
   *   インデックスキーは常に NFC 正規化済み相対パス。
   */
  async refreshFile(relPath: string, absPathHint?: string): Promise<void> {
    const rel = relPath.normalize('NFC');
    if (hasHiddenSegment(rel) || !rel.toLowerCase().endsWith('.md')) return;
    const rootAbs = path.resolve(this.vaultRoot);
    let abs: string;
    if (absPathHint !== undefined) {
      // ヒントも封じ込め検証する (defense in depth)
      abs = path.resolve(absPathHint);
      if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return;
    } else {
      try {
        abs = resolveVaultFile(this.vaultRoot, rel);
      } catch {
        return; // vault 外は決して読まない (defense in depth)
      }
    }
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      this.removeFile(rel);
      return;
    }
    this.notes.set(rel, {
      path: rel,
      title: noteTitle(rel),
      content,
      tags: extractTags(content),
      links: extractLinks(content),
    });
    this.fuseDirty = true;
  }

  removeFile(relPath: string): void {
    if (this.notes.delete(relPath.normalize('NFC'))) {
      this.fuseDirty = true;
    }
  }

  get size(): number {
    return this.notes.size;
  }

  private getFuse(): Fuse<IndexedNote> {
    if (this.fuse === null || this.fuseDirty) {
      this.fuse = new Fuse([...this.notes.values()], FUSE_OPTIONS);
      this.fuseDirty = false;
    }
    return this.fuse;
  }

  /** 全文検索。マッチ箇所を含む行をスニペットとして返す。 */
  search(query: string, limit = 50): SearchResult[] {
    const q = query.normalize('NFC');
    const hits = this.getFuse().search(q, { limit });
    return hits.map((hit) => {
      const snippet = this.snippetFor(hit.item, q, hit.matches);
      return {
        path: hit.item.path,
        title: hit.item.title,
        score: hit.score ?? 0,
        snippet: snippet.text,
        line: snippet.line,
      };
    });
  }

  /**
   * スニペット決定: (1) content 中のクエリ完全一致行、(2) Fuse の content マッチ位置の行、
   * (3) フォールバックでタイトル。
   */
  private snippetFor(
    note: IndexedNote,
    query: string,
    matches: readonly { key?: string; indices: readonly (readonly [number, number])[] }[] = [],
  ): { text: string; line: number | null } {
    const content = note.content;
    const exact = content.toLowerCase().indexOf(query.toLowerCase());
    let offset = exact;
    if (offset === -1) {
      const contentMatch = matches.find((m) => m.key === 'content');
      const first = contentMatch?.indices[0];
      offset = first ? first[0] : -1;
    }
    if (offset === -1) {
      return { text: note.title, line: null };
    }
    const before = content.slice(0, offset);
    const lineNo = before.split('\n').length; // 1 始まり
    const lineStart = before.lastIndexOf('\n') + 1;
    let lineEnd = content.indexOf('\n', offset);
    if (lineEnd === -1) lineEnd = content.length;
    return { text: content.slice(lineStart, lineEnd), line: lineNo };
  }

  /** ノート一覧 (tag / folder フィルタ)。パス昇順。 */
  listNotes(filter: { tag?: string; folder?: string } = {}): NoteMeta[] {
    const tagKey = filter.tag
      ? filter.tag.normalize('NFC').replace(/^#/, '').toLowerCase()
      : null;
    const folderKey = filter.folder
      ? filter.folder.normalize('NFC').replace(/^\/+|\/+$/g, '')
      : null;
    const out: NoteMeta[] = [];
    for (const note of this.notes.values()) {
      if (tagKey !== null) {
        const match = note.tags.some((t) => {
          const k = t.toLowerCase();
          // ネストタグ: tag=dev は dev/api にもマッチ (Obsidian 互換)
          return k === tagKey || k.startsWith(`${tagKey}/`);
        });
        if (!match) continue;
      }
      const folder = note.path.includes('/')
        ? note.path.slice(0, note.path.lastIndexOf('/'))
        : '';
      if (folderKey !== null) {
        if (!(folder === folderKey || folder.startsWith(`${folderKey}/`))) continue;
      }
      out.push({ path: note.path, title: note.title, tags: note.tags, folder });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** タグ一覧 (件数付き、件数降順 → タグ昇順)。大文字小文字は最初の表記を採用。 */
  tags(): TagCount[] {
    const counts = new Map<string, { tag: string; count: number }>();
    for (const note of this.notes.values()) {
      for (const tag of note.tags) {
        const key = tag.toLowerCase();
        const cur = counts.get(key);
        if (cur) {
          cur.count += 1;
        } else {
          counts.set(key, { tag, count: 1 });
        }
      }
    }
    return [...counts.values()].sort((a, b) =>
      a.count !== b.count ? b.count - a.count : a.tag < b.tag ? -1 : 1,
    );
  }

  /**
   * targetRel へのバックリンク一覧。全ノートのリンクを都度解決する
   * (使い捨てインデックス方針 — 事前計算キャッシュより単純さを優先)。
   */
  backlinks(targetRel: string): BacklinkSource[] {
    const target = targetRel.normalize('NFC');
    const paths = [...this.notes.keys()];
    const out: BacklinkSource[] = [];
    for (const note of this.notes.values()) {
      if (note.path === target) continue; // 自己リンクはバックリンクに数えない
      const hits = note.links.filter((l) => resolveLinkTarget(l.target, paths) === target);
      if (hits.length === 0) continue;
      out.push({
        source: note.path,
        links: hits.map((l) => ({
          raw: l.raw,
          heading: l.heading,
          line: l.line,
          context: l.context,
        })),
      });
    }
    out.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    return out;
  }
}
