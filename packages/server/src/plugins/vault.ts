import { Service, type Context } from 'cordis'
import { mkdir, readFile, writeFile, readdir, appendFile } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { normalizeForSave, resolveVaultPath, normalizeVaultPath } from '@loamium/shared'

export interface VaultConfig { root: string }

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
        else if (e.name.endsWith('.md')) out.push(relative(this.config.root, p).split(/[\\/]/).join('/'))
      }
    }
    await walk(this.config.root)
    return out
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
    await this.audit('write', rel, content.length)
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
  private async audit(op: string, path: string, bytes: number): Promise<void> {
    const dir = join(this.config.root, '.loamium')
    const line = JSON.stringify({ ts: new Date().toISOString(), op, path, bytes }) + '\n'
    try {
      await this.ensureDir(dir)
      await appendFile(join(dir, 'audit.log'), line, 'utf8')
    } catch (err: unknown) {
      // 監査の失敗で書き込み自体を落とさない (ログには残す)
      this.ctx.logger('vault').warn('audit append failed: %s', String(err))
    }
  }
}
