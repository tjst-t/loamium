/**
 * モバイルのドロワー。**約束していること**を固定する:
 * 背後をスクロールさせない / Escape と背景タップで閉じる / フォーカスを戻す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Drawer } from '../components/Drawer'

let host: HTMLDivElement
let root: Root
const closed: string[] = []

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  closed.length = 0
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.body.className = ''
})

async function render(open: boolean): Promise<void> {
  await act(async () => {
    root.render(
      <Drawer open={open} onClose={() => closed.push('closed')} side="left" title="ノート">
        <button type="button">中のボタン</button>
      </Drawer>,
    )
  })
}

describe('Drawer', () => {
  it('閉じているときは何も描かない', async () => {
    await render(false)
    expect(host.querySelector('.drawer')).toBeNull()
  })

  it('開くと背後の画面をスクロールさせない', async () => {
    await render(true)
    expect(document.body.classList.contains('is-drawer-open')).toBe(true)
    await render(false)
    expect(document.body.classList.contains('is-drawer-open')).toBe(false)
  })

  it('Escape で閉じる', async () => {
    await render(true)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(closed).toEqual(['closed'])
  })

  it('背景 (scrim) のタップで閉じる。中のタップでは閉じない', async () => {
    await render(true)
    const scrim = host.querySelector('.drawer-scrim')
    const panel = host.querySelector('.drawer')
    await act(async () => { panel?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(closed).toEqual([])
    await act(async () => { scrim?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(closed).toEqual(['closed'])
  })

  it('開いたら中へフォーカスを移し、閉じたら元へ戻す', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)

    await render(true)
    expect(document.activeElement).toBe(host.querySelector('.drawer'))

    await render(false)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('ダイアログとして読み上げられる', async () => {
    await render(true)
    const panel = host.querySelector('.drawer')
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-modal')).toBe('true')
    expect(panel?.getAttribute('aria-label')).toBe('ノート')
  })
})
