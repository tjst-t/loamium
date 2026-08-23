import { toBlob } from 'html-to-image'

/**
 * 描画したものを**画像としてクリップボードへ**置く (数式・図)。
 *
 * SVG も HTML (KaTeX) も同じ経路で扱えるように html-to-image を使う。
 * 書体はページのものを埋め込むので、貼り付け先でも同じ見た目になる。
 */
export async function copyAsImage(el: HTMLElement, background: string): Promise<boolean> {
  try {
    const blob = await toBlob(el, {
      pixelRatio: 2,
      backgroundColor: background,
      // 余白を少し足す (詰まった画像は貼ったときに窮屈に見える)
      style: { padding: '8px' },
    })
    if (blob === null) return false
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch {
    return false
  }
}

/** いまの紙の色 (画像の背景に使う。透過だと貼り付け先で読めないことがある) */
export function paperColor(): string {
  const value = getComputedStyle(document.body).getPropertyValue('--paper').trim()
  return value === '' ? '#ffffff' : value
}
