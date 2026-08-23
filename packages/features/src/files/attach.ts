import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { attachmentKind, isAttachment, parseDelimited, parseWikiLinks } from '@loamium/shared'
import { apiJson } from '@loamium/ui/src/api'
import { attachActions } from '@loamium/ui/src/editor/block-actions'
import { rangeToDelete } from '@loamium/ui/src/editor/hidden-range'
import { filesApi, ASSETS_DIR, type VaultFile } from './contract'

/**
 * 添付ファイルの貼り付けとプレビュー (task #16)。
 *
 * **スキーマは触らない。** 本文に書かれるのは `![[assets/図.png]]` という
 * ただの WikiLink 埋め込みで、その下にプレビューを widget decoration で添える
 * (embed と同じ作り)。`.md` を指すものは embed 機能の担当なので、ここでは触らない。
 */

/** vault の添付一覧。`![[図.png]]` のようにフォルダ抜きで書かれたものを解決するのに要る */
let files: VaultFile[] = []
let filesLoaded = false

async function loadFiles(): Promise<void> {
  files = (await apiJson<{ files: VaultFile[] }>(filesApi.list())).files
  filesLoaded = true
}

/** 書かれた target を実際の vault パスにする。見つからなければ null */
export function resolveAttachment(target: string, known: readonly VaultFile[]): string | null {
  const wanted = target.replace(/^\.\//, '')
  const exact = known.find((f) => f.path === wanted)
  if (exact !== undefined) return exact.path
  const base = wanted.slice(wanted.lastIndexOf('/') + 1)
  const byName = known.find((f) => f.path.slice(f.path.lastIndexOf('/') + 1) === base)
  return byName?.path ?? null
}

interface Found {
  from: number
  to: number
  target: string
  /** `![[図.png|420]]` の幅 (px)。Obsidian と同じ書き方に乗る */
  width: number | null
}

function attachmentsIn(state: EditorState): Found[] {
  const out: Found[] = []
  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || node.text === null || node.text === undefined) return true
    if (parent?.type.spec.code === true) return false
    // ⚠️ インラインコードの中は「書き方の説明」。ここを拾うと、ガイドに書いた
    //    `![[assets/図.png]]` の例までプレビューされる (実機で二重に出た)
    if (node.marks.some((mark) => mark.type.spec.code === true || mark.type.name === 'inlineCode')) return true
    for (const link of parseWikiLinks(node.text)) {
      if (!link.embed || !isAttachment(link.target)) continue
      const width = link.alias !== null && /^\d+$/.test(link.alias) ? Number(link.alias) : null
      out.push({ from: pos + link.start, to: pos + link.end, target: link.target, width })
    }
    return true
  })
  return out
}

/** テキスト系の中身。読み終わるまでは「読み込んでいます…」を出す */
const texts = new Map<string, string>()
const pending = new Set<string>()

/**
 * 画像の大きさを変える。**幅だけを持ち、高さは常に自動** (縦横比は崩さない)。
 *
 * 幅は `![[図.png|420]]` として**ファイルに書く**。これは Obsidian と同じ書き方で、
 * 独自記法ではない (WikiLink の表示名の枠をそのまま使っている)。localStorage に
 * 逃がすと、別の端末や素のエディタで開いたときに大きさが消える。
 */
function addResizeHandle(view: EditorView, box: HTMLElement, img: HTMLImageElement, found: Found): void {
  const handle = document.createElement('div')
  handle.className = 'attachment-resize'
  handle.title = '大きさを変える'
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = img.getBoundingClientRect().width
    const max = box.getBoundingClientRect().width
    let width = startWidth
    const move = (e: PointerEvent): void => {
      width = Math.round(Math.min(Math.max(startWidth + (e.clientX - startX), 40), max))
      img.style.width = `${String(width)}px`
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      // 元の幅に戻す指定は書かない (`|` 無しが「そのまま」)
      const text = width >= max - 2
        ? `![[${found.target}]]`
        : `![[${found.target}|${String(width)}]]`
      const tr = view.state.tr.insertText(text, found.from, found.to)
      view.dispatch(tr)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
  box.append(handle)
}

function previewFor(view: EditorView, found: Found): HTMLElement {
  const target = found.target
  const box = document.createElement('div')
  box.className = 'attachment'
  box.contentEditable = 'false'

  const path = resolveAttachment(target, files)
  if (path === null) {
    box.classList.add('is-missing')
    box.textContent = filesLoaded ? `見つかりません: ${target}` : '読み込んでいます…'
    return box
  }

  const url = filesApi.raw(path)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const kind = attachmentKind(path)

  if (kind === 'image') {
    const img = document.createElement('img')
    img.src = url
    img.alt = name
    img.loading = 'lazy'
    if (found.width !== null) img.style.width = `${String(found.width)}px`
    box.append(img)
    addResizeHandle(view, box, img, found)
  } else if (kind === 'pdf') {
    const frame = document.createElement('iframe')
    frame.src = url
    frame.title = name
    frame.className = 'attachment-pdf'
    box.append(frame)
  } else if (kind === 'audio' || kind === 'video') {
    const media = document.createElement(kind)
    media.src = url
    media.controls = true
    box.append(media)
  } else if (kind === 'csv' || kind === 'text' || kind === 'code') {
    const text = texts.get(path)
    if (text === undefined) {
      box.classList.add('is-loading')
      box.textContent = '読み込んでいます…'
      if (!pending.has(path)) {
        pending.add(path)
        void fetch(url).then(async (r) => r.text()).then((body) => {
          texts.set(path, body)
        }).catch(() => {
          texts.set(path, '(読めませんでした)')
        }).finally(() => {
          pending.delete(path)
          if (!view.isDestroyed) view.dispatch(view.state.tr)
        })
      }
    } else if (kind === 'csv') {
      box.append(tableOf(text, path.endsWith('.tsv') ? '\t' : ','))
    } else {
      const pre = document.createElement('pre')
      pre.className = 'attachment-text'
      pre.textContent = text
      box.append(pre)
    }
  } else {
    box.classList.add('is-file')
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = name
    box.append(link)
  }

  attachActions(box, [
    { label: '開く', run: () => { window.open(url, '_blank', 'noreferrer'); return false } },
    { label: 'パスをコピー', run: async () => copyPath(path) },
    // ⚠️ 記法は隠れているので、キーボードだけだと消し方が分からない。
    //    ファイルは残し、本文の `![[…]]` だけを消す
    { label: '削除', run: () => {
      view.dispatch(view.state.tr.delete(found.from, found.to))
      return false
    } },
  ])
  return box
}

async function copyPath(path: string): Promise<boolean> {
  const { copyText } = await import('@loamium/ui/src/editor/clipboard')
  return copyText(path)
}

/** CSV / TSV を表にする。**先頭行を見出しにする** (ほとんどの CSV がそうなっている) */
function tableOf(text: string, delimiter: string): HTMLElement {
  const rows = parseDelimited(text.trim(), delimiter)
  const table = document.createElement('table')
  table.className = 'attachment-table'
  const [head, ...body] = rows
  if (head !== undefined) {
    const tr = document.createElement('tr')
    for (const cell of head) {
      const th = document.createElement('th')
      th.textContent = cell
      tr.append(th)
    }
    table.append(tr)
  }
  for (const row of body) {
    const tr = document.createElement('tr')
    for (const cell of row) {
      const td = document.createElement('td')
      td.textContent = cell
      tr.append(td)
    }
    table.append(tr)
  }
  return table
}

/** 落としたり貼ったりされたファイルを vault に入れて、`![[…]]` を差し込む */
async function upload(view: EditorView, list: readonly File[], at: number): Promise<void> {
  const inserted: string[] = []
  for (const file of list) {
    try {
      const body = await file.arrayBuffer()
      const result = await apiJson<{ path: string }>(filesApi.upload(`${ASSETS_DIR}/${file.name}`), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      })
      inserted.push(result.path)
    } catch {
      // 1 つ失敗しても残りは入れる (まとめて落としたときに全部消えるほうが困る)
    }
  }
  if (inserted.length === 0) return
  await loadFiles()
  // ⚠️ **段落を作って入れる。** カーソル位置にそのまま差し込むと、見出しの途中に
  //    `![[...]]` が刺さって `# ![[図.png]]見出し` になる (実機で発生)
  const { schema, doc } = view.state
  const $pos = doc.resolve(Math.min(Math.max(at, 0), doc.content.size))
  const paragraphs = inserted.map((path) => schema.nodes['paragraph']?.create(null, schema.text(`![[${path}]]`)))
    .filter((node): node is NonNullable<typeof node> => node !== undefined)
  if (paragraphs.length === 0) return
  const tr = view.state.tr.insert($pos.after($pos.depth === 0 ? undefined : $pos.depth), paragraphs)
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

function filesOf(data: DataTransfer | null): File[] {
  if (data === null) return []
  return [...data.files].filter((file) => !file.name.endsWith('.md'))
}

/**
 * HTML 経由で貼られた `data:` の画像。
 *
 * ⚠️ **base64 のまま本文に入れさせない。** ブラウザから画像をコピーすると
 * クリップボードには `<img src="data:image/png;base64,…">` の HTML しか
 * 入っていないことがあり、素通しすると **数万文字の塊が Markdown に埋まる**
 * (実機で 1 ノートが 39,806 文字になっていた)。ファイルとして vault に出す。
 */
function dataUrlsIn(data: DataTransfer | null): string[] {
  const html = data?.getData('text/html') ?? ''
  return [...html.matchAll(/<img[^>]+src="(data:image\/[^">]+)"/g)]
    .map((m) => m[1])
    .filter((url): url is string => url !== undefined)
}

async function filesFromDataUrls(urls: readonly string[]): Promise<File[]> {
  const out: File[] = []
  for (const [index, url] of urls.entries()) {
    try {
      const blob = await (await fetch(url)).blob()
      const ext = blob.type.split('/')[1]?.split('+')[0] ?? 'png'
      const suffix = index === 0 ? '' : `-${String(index + 1)}`
      out.push(new File([blob], `貼り付け画像${suffix}.${ext}`, { type: blob.type }))
    } catch {
      // 読めないものは諦める (既定の貼り付けに任せる方がまだまし)
    }
  }
  return out
}

/**
 * Backspace / Delete で埋め込みごと消す。
 *
 * ⚠️ **記法は隠れている**ので、素の Backspace だと「見えない文字」を 1 つずつ削ることになり、
 * 何回押しても画像が消えないように見える (実機で「消す手段が無い」と言われた)。
 * カーソルが埋め込みの中か、その直後 (Backspace) / 直前 (Delete) にあるときは、
 * `![[…]]` をまるごと 1 回で消す。
 */
export function deleteAttachmentAt(state: EditorState, back: boolean): { from: number; to: number } | null {
  const { empty, from } = state.selection
  if (!empty) return null
  // 「中にいる」「端に触れている」の判定は共通ヘルパー (どの記法でも同じ約束にする)
  const direct = rangeToDelete(state, back, attachmentsIn(state))
  if (direct !== null) return direct

  const $caret = state.doc.resolve(from)
  for (const found of attachmentsIn(state)) {
    // 埋め込みだけの段落は高さがほとんど無く、そこへカーソルを置くのは難しい。
    // **隣の行から寄せてきたときも** 1 回で消せるようにする (画像を消す一番自然な操作)
    const $block = state.doc.resolve(found.from)
    const alone = $block.parent.textContent.trim() === state.doc.textBetween(found.from, found.to)
    if (!alone) continue
    const blockFrom = $block.before($block.depth)
    const blockTo = $block.after($block.depth)
    const atStart = from === $caret.start($caret.depth)
    const atEnd = from === $caret.end($caret.depth)
    if (back && atStart && blockTo === $caret.before($caret.depth)) return { from: blockFrom, to: blockTo }
    if (!back && atEnd && blockFrom === $caret.after($caret.depth)) return { from: blockFrom, to: blockTo }
  }
  return null
}

const attachPlugin = new Plugin({
  key: new PluginKey('loamium-attachments'),
  view(view) {
    // 一覧はプレビューの解決に要る。取れたら描き直す
    void loadFiles().then(() => { if (!view.isDestroyed) view.dispatch(view.state.tr) }).catch(() => { filesLoaded = true })
    return {}
  },
  props: {
    handleKeyDown(view, event) {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return false
      const range = deleteAttachmentAt(view.state, event.key === 'Backspace')
      if (range === null) return false
      event.preventDefault()
      view.dispatch(view.state.tr.delete(range.from, range.to).scrollIntoView())
      return true
    },
    handlePaste(view, event) {
      const at = view.state.selection.from
      const list = filesOf(event.clipboardData)
      if (list.length > 0) {
        event.preventDefault()
        void upload(view, list, at)
        return true
      }
      const urls = dataUrlsIn(event.clipboardData)
      if (urls.length === 0) return false
      event.preventDefault()
      void filesFromDataUrls(urls).then(async (files) => upload(view, files, at))
      return true
    },
    handleDrop(view, event) {
      const list = filesOf(event.dataTransfer)
      if (list.length === 0) return false
      event.preventDefault()
      const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from
      void upload(view, list, at)
      return true
    },
    decorations(state) {
      const { from: selFrom, to: selTo } = state.selection
      const decorations: Decoration[] = []
      for (const found of attachmentsIn(state)) {
        const path = resolveAttachment(found.target, files)
        decorations.push(Decoration.inline(found.from, found.to, {
          class: 'embed-source',
          'data-target': found.target,
        }))
        // 段落が埋め込みだけなら、隠れたテキストのぶんの空行を詰める (embed と同じ)
        const $pos = state.doc.resolve(found.from)
        if ($pos.parent.textContent.trim() === state.doc.textBetween(found.from, found.to)) {
          decorations.push(Decoration.node($pos.before(), $pos.after(), { class: 'is-embed-only' }))
        }
        // ⚠️ key に**中身の段階**まで入れる。入れないと「読み込んでいます…」の
        //    DOM が使い回されて、読み終わっても更新されない (embed と mermaid で踏んだ罠)
        const phase = path === null ? (filesLoaded ? 'missing' : 'loading') : texts.has(path) ? 'ready' : 'raw'
        decorations.push(Decoration.widget(found.to, (view) => previewFor(view, found), {
          side: 1,
          key: `attachment-${String(found.to)}-${phase}-${found.target}-${String(found.width ?? 0)}`,
          ignoreSelection: true,
        }))
        // 記法そのものは、カーソルが**中に入っている**ときだけ見せる
        if (selFrom > found.from && selTo < found.to) continue
        decorations.push(Decoration.inline(found.from, found.to, { class: 'embed-syntax' }))
      }
      return DecorationSet.create(state.doc, decorations)
    },
  },
})

export const attachments = [$prose(() => attachPlugin)]
