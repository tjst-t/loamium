#!/usr/bin/env node
import { api, ApiError, baseUrl, type TreeNode } from './client'

const USAGE = `loamium — ローカル Markdown ノート

使い方:
  loamium ls                     ノートのパス一覧
  loamium tree                   フォルダ階層を表示する
  loamium cat <path>             ノートを読む
  loamium write <path>           標準入力からノートを書く (既存は上書き)
  loamium new <path>             ノートを新規作成する (既存があれば失敗)
  loamium mv <from> <to>         ノート/フォルダをリネーム・移動する
  loamium rm <path>              ノート/フォルダを削除する (フォルダは中身ごと)
  loamium mkdir <path>           フォルダを作る
  loamium journal [date]         デイリージャーナルを表示する (無ければ作る)
  loamium journal-append <text>  ジャーナルに追記する (--date=YYYY-MM-DD)
  loamium search <query>         ノート名と本文を全文検索する (--limit=N)
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

    case 'tree': {
      const render = (nodes: TreeNode[], indent: string): void => {
        for (const n of nodes) {
          process.stdout.write(`${indent}${n.type === 'folder' ? `${n.name}/` : n.name}\n`)
          if (n.children) render(n.children, `${indent}  `)
        }
      }
      render(await api.tree(), '')
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

    case 'new': {
      const path = rest[0]
      if (path === undefined) { process.stderr.write('パスを指定してください\n'); return 2 }
      // 標準入力がパイプされていれば本文として使う (対話なら空ノート)
      await api.createNote(path, process.stdin.isTTY === true ? '' : await readStdin())
      process.stdout.write(`作成しました: ${path}\n`)
      return 0
    }

    case 'mv': {
      const [from, to] = rest
      if (from === undefined || to === undefined) {
        process.stderr.write('移動元と移動先を指定してください\n'); return 2
      }
      await api.move(from, to)
      process.stdout.write(`${from} → ${to}\n`)
      return 0
    }

    case 'rm': {
      const path = rest[0]
      if (path === undefined) { process.stderr.write('パスを指定してください\n'); return 2 }
      // フォルダかノートかはサーバー側が判別する。CLI は入口を分けない
      if (path.endsWith('.md')) await api.removeNote(path)
      else await api.removeFolder(path)
      process.stdout.write(`削除しました: ${path}\n`)
      return 0
    }

    case 'mkdir': {
      const path = rest[0]
      if (path === undefined) { process.stderr.write('パスを指定してください\n'); return 2 }
      await api.createFolder(path)
      process.stdout.write(`作成しました: ${path}/\n`)
      return 0
    }

    case 'journal': {
      // date は today / yesterday / +3d / YYYY-MM-DD。省略時は今日
      const { content, path, created } = await api.journal(rest[0])
      process.stdout.write(content)
      if (created) process.stderr.write(`(${path} を新規作成しました)\n`)
      return 0
    }

    case 'journal-append': {
      const dateArg = rest.find((a) => a.startsWith('--date='))
      const text = rest.filter((a) => !a.startsWith('--date=')).join(' ')
      if (text === '') { process.stderr.write('追記する内容を指定してください\n'); return 2 }
      const { path } = await api.journalAppend(text, dateArg?.slice('--date='.length))
      process.stdout.write(`追記しました: ${path}\n`)
      return 0
    }

    case 'search': {
      const limitArg = rest.find((a) => a.startsWith('--limit='))
      const query = rest.filter((a) => !a.startsWith('--limit=')).join(' ')
      if (query === '') { process.stderr.write('検索語を指定してください\n'); return 2 }
      const { hits, truncated } = await api.search(
        query, limitArg === undefined ? undefined : Number(limitArg.slice('--limit='.length)))
      for (const h of hits) {
        // grep 互換の `path:line: text` 形式にして、エディタから飛べるようにする
        process.stdout.write(`${h.path}:${h.line}: ${h.snippet}\n`)
      }
      if (hits.length === 0) process.stderr.write('一致するノートはありませんでした\n')
      else if (truncated) process.stderr.write('(件数が多いため打ち切りました。--limit で増やせます)\n')
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
