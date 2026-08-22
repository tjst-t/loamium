import { foldForSearch } from '@loamium/shared'

/** 一致した箇所を一瞬だけ光らせる時間 (ms) */
const FLASH_MS = 1600

/** 描画待ちのリトライ。Milkdown の初期描画はノートを開いた直後には終わっていない */
const RETRY_INTERVAL_MS = 80
const RETRY_TRIES = 15

/**
 * 本文が描画されるのを待ってから `scrollToText` する。
 * 戻り値を呼ぶと中断する (別のノートへ移ったときに古い探索を止めるため)。
 */
export function scrollToTextWhenReady(needle: string): () => void {
  let left = RETRY_TRIES
  const timer = setInterval(() => {
    const root = document.querySelector<HTMLElement>('.milkdown, .source-view')
    // 見つかるか、試行回数を使い切ったら止める
    if ((root !== null && scrollToText(root, needle)) || --left <= 0) clearInterval(timer)
  }, RETRY_INTERVAL_MS)
  return () => { clearInterval(timer) }
}

/**
 * 描画済みの本文から文字列を探し、その行までスクロールして一瞬ハイライトする。
 *
 * ⚠️ **行番号では飛べない。** ProseMirror の文書は Markdown の行と 1:1 対応しないので、
 * 検索語そのものを描画結果から探す。見つからなければ何もしない (静かに諦める)。
 */
export function scrollToText(root: HTMLElement, needle: string): boolean {
  const target = foldForSearch(needle.trim())
  if (target === '') return false

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!foldForSearch(node.textContent ?? '').includes(target)) continue

    const block = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th')
      ?? node.parentElement
    if (block === null || block === undefined) return false

    block.scrollIntoView({ block: 'center', behavior: 'smooth' })
    block.classList.add('search-hit-flash')
    setTimeout(() => { block.classList.remove('search-hit-flash') }, FLASH_MS)
    return true
  }
  return false
}
