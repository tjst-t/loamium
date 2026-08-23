/**
 * 描画したものに添える操作 (数式・図の「編集」「画像としてコピー」)。
 *
 * ⚠️ **描画を直接クリックして編集に入らない。** 押した場所にキャレットが飛ぶと、
 * 「読むつもりで触ったら編集状態になった」が起きる。ホバー (触れない環境ではタップ) で
 * 小さな操作バーを出し、そこから明示的に選ばせる。
 *
 * インラインのものはバーが本文に重なるので、要素の上に浮かせる (`position: fixed`)。
 */
export interface BlockAction {
  label: string
  /** 押したときの処理。true を返すと「done」の見た目を一瞬出す */
  run: () => boolean | Promise<boolean>
}

export interface AttachOptions {
  /** インライン要素に付ける (対象の上に出す。ブロックは右上の内側) */
  inline?: boolean
}

const DONE_MS = 1200

function build(actions: BlockAction[]): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'block-actions'
  bar.contentEditable = 'false'
  for (const action of actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'block-action'
    button.textContent = action.label
    button.title = action.label
    button.addEventListener('mousedown', (event) => {
      // エディタ側にクリックを渡さない (キャレットが飛ぶ / 選択が消える)
      event.preventDefault()
      event.stopPropagation()
      const done = (ok: boolean): void => {
        if (!ok) return
        const before = button.textContent
        button.textContent = 'コピーしました'
        button.classList.add('is-done')
        window.setTimeout(() => {
          button.textContent = before
          button.classList.remove('is-done')
        }, DONE_MS)
      }
      // ⚠️ 同期のものは同期のまま実行する。async で包むと dispatch が 1 tick 遅れ、
      //    「編集」を押した直後の状態が呼び出し側から見えない
      const result = action.run()
      if (result instanceof Promise) void result.then(done)
      else done(result)
    })
    bar.append(button)
  }
  return bar
}

/**
 * バーの位置。ブロックは右上の内側、インラインは対象の上。
 *
 * ⚠️ **バーは対象の中に入れず、常に浮かせる (`position: fixed`)。**
 * 中に置くと `overflow: auto` の要素 (図など) にクリップされ、はみ出した部分が
 * 押せなくなる。実機ではボタンに触れた瞬間にバーが消える形で出た。
 */
function place(bar: HTMLElement, target: HTMLElement, inline: boolean): void {
  const box = target.getBoundingClientRect()
  const width = bar.offsetWidth
  const height = bar.offsetHeight
  const left = inline ? box.right - width : box.right - width - 6
  const top = inline ? box.top - height - 4 : box.top + 6
  bar.style.left = `${String(Math.round(Math.min(Math.max(left, 8), window.innerWidth - width - 8)))}px`
  bar.style.top = `${String(Math.round(Math.max(top, 8)))}px`
}

/**
 * 操作バーを付ける。ブロックには内側の右上へ、インラインには浮かせて上へ。
 * ホバーで出し、離れたら消す。タップでも出る (触る環境ではホバーが無い)。
 */
export function attachActions(host: HTMLElement, actions: BlockAction[], options: AttachOptions = {}): void {
  const inline = options.inline === true
  const bar = build(actions)

  const reposition = (): void => { if (bar.isConnected) place(bar, host, inline) }

  // ⚠️ 表示中かは **DOM に繋がっているか**で見る。boolean で憶えると、外から
  //    バーを消されたときに「出したつもり」のまま二度と出なくなる
  const show = (): void => {
    if (bar.isConnected) return
    document.body.append(bar)
    place(bar, host, inline)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
  }
  const hide = (): void => {
    if (!bar.isConnected) return
    bar.remove()
    window.removeEventListener('scroll', reposition, true)
    window.removeEventListener('resize', reposition)
  }

  host.addEventListener('pointerenter', show)
  host.addEventListener('pointerleave', (event) => {
    // バーの上へ移った場合は消さない
    if (event.relatedTarget instanceof Node && bar.contains(event.relatedTarget)) return
    window.setTimeout(() => { if (!bar.matches(':hover')) hide() }, 120)
  })
  bar.addEventListener('pointerleave', () => { window.setTimeout(hide, 120) })
  // 触る環境: タップで出す (この時点では編集に入らない)
  host.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return
    event.preventDefault()
    show()
  })
}
