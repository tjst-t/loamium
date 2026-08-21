import { Service, type Context } from 'cordis'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

export interface VaultConfig { root: string }

/**
 * vault = Markdown ファイルの正本。
 * 旧実装の `ensureDir()` 規約は維持する (bun on Windows の mkdir EEXIST 対策)。
 */
export class VaultService extends Service {
  static readonly inject = []
  constructor(ctx: Context, public config: VaultConfig) {
    super(ctx, 'vault')
  }

  /** bun on Windows で既存ディレクトリへの mkdir(recursive) が EEXIST を投げる件の共通ヘルパー */
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
        else if (e.name.endsWith('.md')) out.push(relative(this.config.root, p))
      }
    }
    await walk(this.config.root)
    return out
  }

  async read(path: string): Promise<string> {
    return readFile(join(this.config.root, path), 'utf8')
  }

  async write(path: string, body: string): Promise<void> {
    const full = join(this.config.root, path)
    await this.ensureDir(join(full, '..'))
    await writeFile(full, body, 'utf8')
    // 単一コールバックスロットではなく、イベントとして撒く
    this.ctx.emit('vault/change', path, 'upsert')
  }
}
