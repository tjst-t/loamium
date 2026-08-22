import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Editor as MilkdownEditor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { splitFrontmatter, joinFrontmatter, normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from './markdown-config'
import { exitNodeKeymap } from './exit-node'
import { outline } from './outline'

export type Mode = 'wysiwyg' | 'source'

interface MilkdownHostProps {
  initialBody: string
  onChange: (markdown: string) => void
}

function MilkdownHost({ initialBody, onChange }: MilkdownHostProps): JSX.Element {
  useEditor((root) =>
    MilkdownEditor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initialBody)
        // shared の remark-stringify 設定を注入する (これを忘れると gate を外れる)
        applyLoamiumStringifyOptions(ctx)
        ctx.get(listenerCtx).markdownUpdated((_, markdown) => onChange(markdown))
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(exitNodeKeymap)
      .use(outline),
  )
  return <Milkdown />
}

export interface EditorProps {
  /** ファイルの内容そのもの (frontmatter を含む) */
  value: string
  onSave: (next: string) => void
}

/**
 * ソースモードのトグルは一級市民 (ADR-0035 の受け入れ条件 1)。
 * 外部エディタ・git・エージェントが同じファイルを直接触る以上、必須。
 * **文書単位**で切り替える (行単位ではない)。
 */
export function Editor({ value, onSave }: EditorProps): JSX.Element {
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

  const dirty = draftBody !== bodyRef.current
  const save = useCallback(() => {
    // **書き戻しは必ず normalizeForSave を通す。**
    // Milkdown と shared は serializer が別物なので、素のまま書くと正規形が食い違い、
    // サーバー/CLI 側が書き直したときに git の diff が振動する。
    onSave(joinFrontmatter({ frontmatter, body: normalizeForSave(draftBody) }))
  }, [frontmatter, draftBody, onSave])

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <div className="mode-toggle" role="group" aria-label="表示モード">
          <button
            type="button"
            aria-pressed={mode === 'wysiwyg'}
            onClick={() => setMode('wysiwyg')}
          >
            エディタ
          </button>
          <button
            type="button"
            aria-pressed={mode === 'source'}
            onClick={() => setMode('source')}
          >
            ソース
          </button>
        </div>
        {frontmatter !== null && (
          <span className="badge" title="frontmatter はエディタ外で扱う (ADR-0035)">
            frontmatter あり
          </span>
        )}
        <button type="button" onClick={save} disabled={!dirty}>
          保存{dirty ? ' *' : ''}
        </button>
      </div>

      {mode === 'wysiwyg' ? (
        <MilkdownProvider>
          {/* key で強制再マウント: ファイルを切り替えたら中身を作り直す */}
          <MilkdownHost key={value} initialBody={body} onChange={handleChange} />
        </MilkdownProvider>
      ) : (
        <textarea
          className="source-view"
          value={draftBody}
          spellCheck={false}
          onChange={(e) => setDraftBody(e.target.value)}
        />
      )}
    </div>
  )
}

export { editorViewCtx, serializerCtx }
