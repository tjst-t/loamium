/**
 * クリップボード。
 *
 * ⚠️ **`navigator.clipboard` は当てにできない。** LAN の IP に http で繋いだとき
 * (`http://10.10.254.36:8201` — このアプリの普通の使い方) はセキュアコンテキストで
 * はないので `navigator.clipboard` が **undefined** になる。実機でコピーが全く
 * 効かなかったのはこれ。secure なら新 API、そうでなければ `execCommand('copy')` に落ちる。
 */

/** 隠しの入れ物を置いて選択 → execCommand する共通処理 */
function withHiddenSelection(fill: (holder: HTMLElement) => void): boolean {
  const holder = document.createElement('div')
  holder.contentEditable = 'true'
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
  fill(holder)
  document.body.append(holder)
  const selection = window.getSelection()
  const saved = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  try {
    const range = document.createRange()
    range.selectNodeContents(holder)
    selection?.removeAllRanges()
    selection?.addRange(range)
    return document.execCommand('copy')
  } finally {
    selection?.removeAllRanges()
    if (saved !== null) selection?.addRange(saved)
    holder.remove()
  }
}

export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard as unknown !== undefined) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* 落ちたら下の経路を試す */ }
  }
  // ⚠️ contenteditable に入れて選択すると **HTML 混じり**で貼られる (書体や色の span が付く)。
  //    素のテキストが欲しいので textarea を使う
  const area = document.createElement('textarea')
  area.value = text
  area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
  document.body.append(area)
  try {
    area.select()
    return document.execCommand('copy')
  } finally {
    area.remove()
  }
}

/**
 * 画像 (PNG) を置く。
 *
 * フォールバックは `<img>` を選択して `execCommand('copy')`。Chrome / Edge は
 * これで画像として貼り付けられる。**非同期の描画が終わってから呼ぶこと** —
 * ユーザー操作の余韻 (transient activation) が切れると execCommand も効かない。
 */
export async function copyImage(blob: Blob): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard as unknown !== undefined) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    } catch { /* 落ちたら下の経路を試す */ }
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result)) }
    reader.onerror = () => { reject(new Error('画像を読めません')) }
    reader.readAsDataURL(blob)
  })
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  return withHiddenSelection((holder) => { holder.append(image) })
}
