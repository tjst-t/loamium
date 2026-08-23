import { Service, type Context } from 'cordis'
import type { Stats } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, appendFile, rename, rm, stat } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import {
  normalizeForSave, normalizeVaultPath, preferredWikiTarget, resolveWikiLink, rewriteWikiLinks,
  VaultPathError,
} from '@loamium/shared'
import { resolveVaultPath } from '@loamium/shared/src/vault-path.node'
import { VaultConflictError, VaultNotFoundError } from '../errors'

export interface VaultConfig { root: string }

/** ツリー 1 ノード。フォルダは children を持つ (空フォルダも children: []) */
export interface TreeNode {
  name: string
  /** vault 相対パス (`/` 区切り) */
  path: string
  type: 'folder' | 'note'
  children?: TreeNode[]
}

/**
 * vault = Markdown ファイルの正本。
 * **ファイルに触る経路はすべてこのサービスを通す** (パス検証・正規化・監査を一箇所に集約するため)。
 */
export class VaultService extends Service {
  static readonly inject = []
  constructor(ctx: Context, public config: VaultConfig) {
    super(ctx, 'vault')
  }

  /**
   * bun on Windows では既存ディレクトリへの mkdir(recursive) が EEXIST を投げる
   * (Node/tsx・bun-linux では再現しない)。書き込み系はすべてこれを経由すること。
   */
  async ensureDir(dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true })
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    }
  }

  async list(): Promise<string[]> {
    await this.ensureDir(this.config.root)
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.name.endsWith('.md')) out.push(this.toRel(p))
      }
    }
    await walk(this.config.root)
    return out
  }

  /** 絶対パス → vault 相対パス (`/` 区切り)。Windows の `\` もここで吸収する */
  private toRel(full: string): string {
    return relative(this.config.root, full).split(/[\\/]/).join('/')
  }

  private async statOrNull(full: string): Promise<Stats | null> {
    try {
      return await stat(full)
    } catch {
      return null
    }
  }

  /** フォルダ配下の .md を列挙する (移動・削除でイベントを撒く対象) */
  private async notesUnder(relDir: string): Promise<string[]> {
    const prefix = relDir === '' ? '' : `${relDir}/`
    return (await this.list()).filter((p) => p.startsWith(prefix))
  }

  /**
   * サイドバー用のフォルダツリー。**空フォルダも残す** (作った直後に消えると混乱するため)。
   * インデックス (`noteIndex`) はパスの平坦な集合しか持たないので、階層はここで組む。
   */
  async tree(): Promise<TreeNode[]> {
    await this.ensureDir(this.config.root)
    const walk = async (dir: string): Promise<TreeNode[]> => {
      const nodes: TreeNode[] = []
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const full = join(dir, e.name)
        const rel = this.toRel(full)
        if (e.isDirectory()) {
          nodes.push({ name: e.name, path: rel, type: 'folder', children: await walk(full) })
        } else if (e.name.endsWith('.md')) {
          nodes.push({ name: e.name, path: rel, type: 'note' })
        }
      }
      // フォルダ先 → 名前順 (日本語を辞書順に並べる)
      return nodes.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name, 'ja') : a.type === 'folder' ? -1 : 1)
    }
    return walk(this.config.root)
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(resolveVaultPath(this.config.root, path))
      return true
    } catch {
      return false
    }
  }

  /** 新規作成。**既存を黙って壊さない** ため、あれば VaultConflictError */
  async create(path: string, body = ''): Promise<string> {
    const rel = normalizeVaultPath(path)
    if (await this.exists(rel)) throw new VaultConflictError(`すでに存在します: ${rel}`)
    await this.write(rel, body)
    return rel
  }

  async remove(path: string): Promise<string> {
    const rel = normalizeVaultPath(path)
    const full = resolveVaultPath(this.config.root, rel)
    const info = await this.statOrNull(full)
    if (info === null) throw new VaultNotFoundError(`存在しません: ${rel}`)
    // フォルダは中身ごと消す。消えたノートはすべてイベントで撒く (index / SSE がそれで畳む)
    const gone = info.isDirectory() ? await this.notesUnder(rel) : [rel]
    await rm(full, { recursive: true, force: true })
    await this.audit(info.isDirectory() ? 'remove_folder' : 'remove', rel)
    for (const p of gone) this.ctx.emit('vault/change', p, 'remove')
    return rel
  }

  /** リネーム / 移動。ノートでもフォルダでも同じ入口を使う */
  async move(from: string, to: string): Promise<{ from: string; to: string; linksUpdated: string[] }> {
    const relFrom = normalizeVaultPath(from)
    const relTo = normalizeVaultPath(to)
    const fullFrom = resolveVaultPath(this.config.root, relFrom)
    const fullTo = resolveVaultPath(this.config.root, relTo)
    const info = await this.statOrNull(fullFrom)
    if (info === null) throw new VaultNotFoundError(`存在しません: ${relFrom}`)
    if (relFrom === relTo) return { from: relFrom, to: relTo, linksUpdated: [] }
    if (await this.exists(relTo)) throw new VaultConflictError(`すでに存在します: ${relTo}`)
    if (info.isDirectory() && (relTo + '/').startsWith(relFrom + '/')) {
      throw new VaultConflictError(`フォルダを自分の中には移動できません: ${relFrom} → ${relTo}`)
    }

    const before = info.isDirectory() ? await this.notesUnder(relFrom) : [relFrom]
    await this.ensureDir(dirname(fullTo))
    await rename(fullFrom, fullTo)
    await this.audit('move', relFrom, { to: relTo })
    const moved = new Map(before.map((p) => [p, relTo + p.slice(relFrom.length)]))
    for (const [from_, to_] of moved) {
      this.ctx.emit('vault/change', from_, 'remove')
      this.ctx.emit('vault/change', to_, 'upsert')
    }
    const linksUpdated = await this.followLinks(moved)
    return { from: relFrom, to: relTo, linksUpdated }
  }

  /**
   * リネーム・移動に本文の `[[リンク]]` を追従させる (task #5)。
   *
   * **move() の中で必ず呼ぶ。** UI・CLI・エージェントのどの経路から移動しても
   * 同じように追いつかせるため、ルート側ではなくサービス層に置く。
   *
   * 書き方は保つ: 元が `[[フォルダ/ノート]]` ならフォルダ付きのまま、
   * `[[ノート]]` なら (名前が一意な限り) ノート名のまま。見出しと表示名も保つ。
   */
  private async followLinks(moved: ReadonlyMap<string, string>): Promise<string[]> {
    if (moved.size === 0) return []
    const after = await this.list()
    const toOld = new Map([...moved].map(([from_, to_]) => [to_, from_]))
    // 移動前のパス集合。リンクは「移動前の書き方」で書かれているのでこれで解決する
    const beforeAll = after.map((p) => toOld.get(p) ?? p)

    const changed: string[] = []
    for (const path of after) {
      const selfBefore = toOld.get(path) ?? path
      let content: string
      try {
        content = await this.read(path)
      } catch {
        continue // 走査中に消えたファイルで移動全体を落とさない
      }
      const next = rewriteWikiLinks(content, (link) => {
        const resolved = resolveWikiLink(link.target, beforeAll, selfBefore)
        const moveTo = resolved === null ? undefined : moved.get(resolved)
        if (moveTo === undefined) return null
        // 元がフォルダ付きならフォルダ付きのまま書く
        return link.target.includes('/')
          ? moveTo.replace(/\.md$/i, '')
          : preferredWikiTarget(moveTo, after)
      })
      if (next === content) continue
      await this.write(path, next)
      changed.push(path)
    }
    if (changed.length > 0) {
      this.ctx.logger('vault').info('links followed: %d ファイル', changed.length)
    }
    return changed
  }

  async createFolder(path: string): Promise<string> {
    const rel = normalizeVaultPath(path)
    if (await this.exists(rel)) throw new VaultConflictError(`すでに存在します: ${rel}`)
    await this.ensureDir(resolveVaultPath(this.config.root, rel))
    await this.audit('create_folder', rel)
    return rel
  }

  /**
   * 添付ファイル (.md 以外) の一覧。ノートの索引には入れない —
   * `noteIndex` は Markdown の索引で、画像を混ぜるとリンク解決が壊れる。
   */
  async listFiles(): Promise<{ path: string; size: number; mtime: string }[]> {
    await this.ensureDir(this.config.root)
    const out: { path: string; size: number; mtime: string }[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) { await walk(full); continue }
        if (e.name.endsWith('.md')) continue
        const info = await this.statOrNull(full)
        if (info === null) continue
        out.push({ path: this.toRel(full), size: info.size, mtime: info.mtime.toISOString() })
      }
    }
    await walk(this.config.root)
    return out.sort((a, b) => a.path.localeCompare(b.path, 'ja'))
  }

  /** 添付をそのまま読む (画像・PDF)。テキストとして解釈しない */
  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(resolveVaultPath(this.config.root, path)))
  }

  /** 添付を書く。**normalizeForSave は通さない** (Markdown ではないため) */
  async writeBytes(path: string, data: Uint8Array): Promise<string> {
    const rel = normalizeVaultPath(path)
    if (rel.endsWith('.md')) throw new VaultPathError('添付として .md は書けません')
    const full = resolveVaultPath(this.config.root, rel)
    await this.ensureDir(dirname(full))
    await writeFile(full, data)
    await this.audit('upload', rel, { bytes: data.byteLength })
    this.ctx.emit('vault/change', rel, 'upsert')
    return rel
  }

  async read(path: string): Promise<string> {
    // vault 脱出の検証込み。URL エンコードされた `..` もデコード後にここで弾かれる
    return readFile(resolveVaultPath(this.config.root, path), 'utf8')
  }

  async write(path: string, body: string): Promise<void> {
    const rel = normalizeVaultPath(path)
    const full = resolveVaultPath(this.config.root, rel)
    // **書き戻しは必ず normalizeForSave を通す** (エディタとサーバーの正規形を一致させる)
    const content = rel.endsWith('.md') ? normalizeForSave(body) : body
    await this.ensureDir(dirname(full))
    await writeFile(full, content, 'utf8')
    await this.audit('write', rel, { bytes: content.length })
    // 単一コールバックスロットではなく、イベントとして撒く
    this.ctx.emit('vault/change', rel, 'upsert')
  }

  /**
   * vault 全体を正規形へ揃える (ADR-0035 が前提にしている「初回の正規化コミット」)。
   * これを一度通しておけば、以後 1 文字編集の diff は 1 行で済む。
   */
  async fmt(options: { dryRun?: boolean } = {}): Promise<{ scanned: number; changed: string[] }> {
    const changed: string[] = []
    const paths = await this.list()
    for (const rel of paths) {
      const before = await this.read(rel)
      const after = normalizeForSave(before)
      if (before === after) continue
      changed.push(rel)
      if (options.dryRun !== true) await this.write(rel, after)
    }
    this.ctx.logger('vault').info(
      'fmt: %d/%d 件を正規化%s', changed.length, paths.length, options.dryRun === true ? ' (dry-run)' : '',
    )
    return { scanned: paths.length, changed }
  }

  /** 書き込み系 API は監査ログに記録する */
  private async audit(op: string, path: string, extra: Record<string, unknown> = {}): Promise<void> {
    const dir = join(this.config.root, '.loamium')
    const line = JSON.stringify({ ts: new Date().toISOString(), op, path, ...extra }) + '\n'
    try {
      await this.ensureDir(dir)
      await appendFile(join(dir, 'audit.log'), line, 'utf8')
    } catch (err: unknown) {
      // 監査の失敗で書き込み自体を落とさない (ログには残す)
      this.ctx.logger('vault').warn('audit append failed: %s', String(err))
    }
  }
}
