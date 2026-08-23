import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { Editor as MilkdownEditor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { splitFrontmatter, joinFrontmatter, normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from './markdown-config'
import { exitNodeKeymap } from './exit-node'
import { setEditorEnv } from './editor-env'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { getNoteViewState, saveNoteViewState, type NoteViewState } from './view-state'

export type Mode = 'wysiwyg' | 'source'

/**
 * 実際にスクロールしている祖先を探す。
 *
 * ⚠️ **`.milkdown` を決め打ちしないこと。** CSS 上は `.milkdown` が `overflow: auto` だが、
 * flex の高さがそのまま伸びるため、実際にスクロールしているのは `.main` 側だった。
 * クラス名ではなく「スクロールできるか」で選ぶ。
 */
function scrollParentOf(node: HTMLElement | null): HTMLElement | null {
  let fallback: HTMLElement | null = null
  for (let el = node; el !== null; el = el.parentElement) {
    const overflowY = window.getComputedStyle(el).overflowY
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue
    if (el.scrollHeight > el.clientHeight) return el
    fallback ??= el
  }
  return fallback
}

interface MilkdownHostProps {
  /** 表示状態を憶える単位。ノートのパス */
  path: string
  initialBody: string
  onChange: (markdown: string) => void
  /** vault の全ノート。リンク解決と `[[` 補完に使う */
  notes: readonly string[]
  /** vault のタグ。`#` 補完に使う */
  tags: readonly string[]
  onOpenLink: (path: string) => void
  onCreateLink: (target: string) => void
  onOpenTag: (tag: string) => void
  /** 有効な機能が持ち込む Milkdown プラグイン (preset の前/後) */
  beforePreset: MilkdownPlugin[]
  afterPreset: MilkdownPlugin[]
}

function MilkdownHost({
  path, initialBody, onChange, notes, tags, onOpenLink, onCreateLink, onOpenTag,
  beforePreset, afterPreset,
}: MilkdownHostProps): JSX.Element {
  // 最新の表示状態。アンマウント時にこれをそのまま保存する
  const viewState = useRef<NoteViewState>({ cursor: 0, scrollTop: 0 })

  const { loading, get } = useEditor((root) =>
    MilkdownEditor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initialBody)
        // shared の remark-stringify 設定を注入する (これを忘れると gate を外れる)
        applyLoamiumStringifyOptions(ctx)
        ctx.get(listenerCtx).markdownUpdated((_, markdown) => onChange(markdown))
        ctx.get(listenerCtx).selectionUpdated((_, selection) => {
          viewState.current.cursor = selection.from
        })
      })
      // ⚠️ 順序が意味を持つ。補完系 (`[[` / `#`) は Enter / Tab をリストのコマンドより
      // 先に拾う必要があるので preset より**前**。並びの出所は features.ts の 1 か所だけ
      .use(beforePreset)
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(exitNodeKeymap)
      .use(afterPreset),
  )

  /**
   * リンク解決に要るものを React 側から差し込む。
   * ノート一覧が変わったら空の transaction を投げて decoration を貼り直す
   * (decoration の再計算は state の変化でしか起きないため)。
   */
  useEffect(() => {
    setEditorEnv({
      notes, tags, currentPath: path, open: onOpenLink, create: onCreateLink, openTag: onOpenTag,
    })
    if (loading) return
    get()?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.dispatch(view.state.tr)
    })
  }, [loading, get, notes, tags, path, onOpenLink, onCreateLink, onOpenTag])

  /**
   * ノートを開き直したときにスクロールとカーソルを戻す (task #2)。
   *
   * 復元でフォーカスは奪わない。ツリーやパレットから開いた直後に
   * キー入力の行き先が勝手に本文へ移ると、続けて操作している側が壊れるため。
   */
  useEffect(() => {
    if (loading) return undefined
    let view: EditorView | undefined
    get()?.action((ctx) => { view = ctx.get(editorViewCtx) })
    if (view === undefined) return undefined
    const pmView = view
    const scroller = scrollParentOf(pmView.dom.parentElement)

    const saved = getNoteViewState(path)
    if (saved !== undefined) {
      const pos = Math.min(Math.max(saved.cursor, 0), pmView.state.doc.content.size)
      pmView.dispatch(pmView.state.tr.setSelection(TextSelection.near(pmView.state.doc.resolve(pos))))
      if (scroller !== null) scroller.scrollTop = saved.scrollTop
      viewState.current = { ...saved }
    }

    const onScroll = (): void => {
      viewState.current.scrollTop = scroller?.scrollTop ?? 0
    }
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller?.removeEventListener('scroll', onScroll)
      saveNoteViewState(path, { ...viewState.current })
    }
  }, [loading, get, path])

  return <Milkdown />
}

export interface EditorProps {
  /** 開いているノートの vault パス。表示状態を憶える単位になる */
  path: string
  /** vault の全ノート。`[[リンク]]` の解決と補完に使う */
  notes: readonly string[]
  /** vault のタグ。`#` の補完に使う */
  tags: readonly string[]
  /** リンクをクリックしたとき */
  onOpenLink: (path: string) => void
  /** 壊れリンクをクリックしたとき (新規作成) */
  onCreateLink: (target: string) => void
  /** タグをクリックしたとき (詳細検索へ) */
  onOpenTag: (tag: string) => void
  /** 有効な機能が持ち込む Milkdown プラグイン */
  beforePreset: MilkdownPlugin[]
  afterPreset: MilkdownPlugin[]
  /** 機能が差し込むノート操作 (★ など)。シェルが集めて渡す */
  actions?: ReactNode
  /** ファイルの内容そのもの (frontmatter を含む) */
  value: string
  onSave: (next: string) => void
}

/**
 * ソースモードのトグルは一級市民 (ADR-0035 の受け入れ条件 1)。
 * 外部エディタ・git・エージェントが同じファイルを直接触る以上、必須。
 * **文書単位**で切り替える (行単位ではない)。
 */
export function Editor({
  path, notes, tags, value, onSave, onOpenLink, onCreateLink, onOpenTag, beforePreset, afterPreset, actions,
}: EditorProps): JSX.Element {
  const [mode, setMode] = useState<Mode>('wysiwyg')
  const { frontmatter, body } = useMemo(() => splitFrontmatter(value), [value])
  const [draftBody, setDraftBody] = useState(body)
  const bodyRef = useRef(body)

  useEffect(() => {
    bodyRef.current = body
    setDraftBody(body)
  }, [body])

  const handleChange = useCallback((markdown: string) => {
    setDraftBody(markdown)
  }, [])

  /**
   * ソースモードは**中身の高さまで伸ばす**。textarea の中でスクロールさせると、
   * 本文のスクロール (`.main`) と二重になって迷子になる。
   */
  const sourceRef = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const area = sourceRef.current
    if (area === null) return
    area.style.height = 'auto'
    area.style.height = `${String(area.scrollHeight)}px`
  }, [draftBody, mode])

  /**
   * ⚠️ **正規形どうしで比べる。** Milkdown の serializer と `normalizeForSave()` は
   * 出力が違う (エスケープの入れ方など)。素の文字列で比べると、保存した直後に
   * エディタが吐き直したものが「正規形と違う」ままになり、**永久に未保存扱い**になる
   * (実機で発生: 画像を貼って保存しても「未保存の変更を保存」が消えなかった)。
   */
  const savedBody = useMemo(() => normalizeForSave(body), [body])
  const dirty = useMemo(() => normalizeForSave(draftBody) !== savedBody, [draftBody, savedBody])
  const save = useCallback(() => {
    // **書き戻しは必ず normalizeForSave を通す。**
    // Milkdown と shared は serializer が別物なので、素のまま書くと正規形が食い違い、
    // サーバー/CLI 側が書き直したときに git の diff が振動する。
    onSave(joinFrontmatter({ frontmatter, body: normalizeForSave(draftBody) }))
  }, [frontmatter, draftBody, onSave])

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <div className="toolbar-inner">
        <div className="mode-toggle" role="group" aria-label="表示モード">
          <button
            type="button"
            aria-pressed={mode === 'wysiwyg'}
            onClick={() => setMode('wysiwyg')}
          >
            編集
          </button>
          <button
            type="button"
            aria-pressed={mode === 'source'}
            onClick={() => setMode('source')}
          >
            .md
          </button>
        </div>
        {/*
          ⚠️ **frontmatter の有無でバーの中身を増やさない。** 以前は「frontmatter」バッジを
          出していたが、★ を押した瞬間にバッジが現れて右のものが動いた。
          frontmatter があるかどうかは、右のプロパティパネルを見れば分かる。
        */}
        {actions}
        <button
          type="button"
          className={`save-button${dirty ? ' is-dirty' : ''}`}
          onClick={save}
          disabled={!dirty}
        >
          {dirty ? '未保存の変更を保存' : '保存済み'}
        </button>
        </div>
      </div>

      <div className="editor-body">
        {mode === 'wysiwyg' ? (
        <MilkdownProvider>
          {/*
            key で強制再マウント: ファイルを切り替えたら中身を作り直す。
            ⚠️ **value ではなく body で keying する。** プロパティパネルが frontmatter を
            書き換えただけでエディタが作り直されると、カーソルもスクロールも飛ぶ。
          */}
          <MilkdownHost
            key={body}
            path={path}
            initialBody={body}
            onChange={handleChange}
            notes={notes}
            tags={tags}
            onOpenLink={onOpenLink}
            onCreateLink={onCreateLink}
            onOpenTag={onOpenTag}
            beforePreset={beforePreset}
            afterPreset={afterPreset}
          />
        </MilkdownProvider>
        ) : (
          <textarea
            ref={sourceRef}
            className="source-view"
            value={draftBody}
            spellCheck={false}
            onChange={(e) => { setDraftBody(e.target.value) }}
          />
        )}
      </div>
    </div>
  )
}

export { editorViewCtx, serializerCtx }
