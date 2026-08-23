import { describe, expect, it, vi, afterEach } from 'vitest'
import { copyText, copyImage } from '../clipboard'

/**
 * ⚠️ ここが守っているのは「**非セキュアな http でもコピーできる**」こと。
 * LAN の IP (`http://10.10.254.36:8201`) では `navigator.clipboard` が無く、
 * 新 API だけの実装は実機で全く効かなかった。
 */
describe('クリップボード', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('navigator.clipboard が無くてもテキストをコピーできる', async () => {
    vi.stubGlobal('isSecureContext', false)
    const exec = vi.fn(() => true)
    document.execCommand = exec as unknown as typeof document.execCommand
    expect(await copyText('graph TD')).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    // 後片付けまでやる (隠しの入れ物を置きっぱなしにしない)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('セキュアなら新 API を使う', async () => {
    vi.stubGlobal('isSecureContext', true)
    const writeText = vi.fn(async () => { /* ok */ })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyText('$x$')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('$x$')
  })

  it('画像は execCommand に落ちても入れ物を残さない', async () => {
    vi.stubGlobal('isSecureContext', false)
    document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand
    // jsdom は画像をデコードしないので decode() だけ差し替える
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true, value: async () => { /* ok */ },
    })
    expect(await copyImage(new Blob(['x'], { type: 'image/png' }))).toBe(true)
    expect(document.body.querySelectorAll('div[contenteditable]')).toHaveLength(0)
  })
})
