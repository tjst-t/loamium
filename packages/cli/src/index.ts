#!/usr/bin/env node
import { api, ApiError, baseUrl } from './client'

const USAGE = `loamium — ローカル Markdown ノート

使い方:
  loamium ls                     ノートのパス一覧
  loamium cat <path>             ノートを読む
  loamium write <path>           標準入力からノートを書く
  loamium fmt [--dry-run]        vault 全体を標準 Markdown へ正規化する
  loamium tools                  エージェント操作ツールの一覧
  loamium help [topic]           help 知識ベースを引く

接続先は LOAMIUM_URL (既定: ${baseUrl()})。先に \`make serve\` でサーバを起動してください。
`

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString('utf8')
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE)
      return 0

    case 'ls': {
      for (const p of await api.listNotes()) process.stdout.write(`${p}\n`)
      return 0
    }

    case 'cat': {
      const path = rest[0]
      if (path === undefined) { process.stderr.write('パスを指定してください\n'); return 2 }
      process.stdout.write(await api.readNote(path))
      return 0
    }

    case 'write': {
      const path = rest[0]
      if (path === undefined) { process.stderr.write('パスを指定してください\n'); return 2 }
      await api.writeNote(path, await readStdin())
      process.stdout.write(`書き込みました: ${path}\n`)
      return 0
    }

    case 'fmt': {
      const dryRun = rest.includes('--dry-run')
      const { scanned, changed } = await api.fmt(dryRun)
      for (const p of changed) process.stdout.write(`  ${dryRun ? 'M' : '正規化'} ${p}\n`)
      process.stdout.write(
        changed.length === 0
          ? `${scanned} 件を確認。すべて正規形です。\n`
          : dryRun
            ? `\n${scanned} 件中 ${changed.length} 件が変更されます (--dry-run のため書き込んでいません)。\n`
            : `\n${scanned} 件中 ${changed.length} 件を正規化しました。\n`,
      )
      return 0
    }

    case 'tools': {
      for (const t of await api.tools()) {
        process.stdout.write(`  ${t.name.padEnd(14)} [${t.capability}] ${t.description}\n`)
      }
      return 0
    }

    case 'help': {
      const topic = rest[0]
      if (topic === undefined) {
        for (const t of await api.helpTopics()) process.stdout.write(`  ${t}\n`)
        return 0
      }
      process.stdout.write(await api.help(topic))
      return 0
    }

    default:
      process.stderr.write(`未知のコマンド: ${cmd}\n\n${USAGE}`)
      return 2
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err: unknown) {
  if (err instanceof ApiError) {
    process.stderr.write(`エラー: ${err.message}\n`)
    if (err.status === 0 || err.status >= 500) {
      process.stderr.write(`サーバが起動しているか確認してください (${baseUrl()})\n`)
    }
  } else if (err instanceof Error && err.message.includes('fetch failed')) {
    process.stderr.write(`サーバに接続できません (${baseUrl()})。\`make serve\` で起動してください。\n`)
  } else {
    process.stderr.write(`エラー: ${String(err)}\n`)
  }
  process.exitCode = 1
}
