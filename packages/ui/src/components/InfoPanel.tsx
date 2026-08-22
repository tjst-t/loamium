import { useEffect, useState, type JSX } from 'react'
import { Link2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { fetchBacklinks, type Backlink } from '../api'

export interface InfoPanelProps {
  open: boolean
  onToggle: () => void
  path: string | null
  content: string | null
  /** バックリンクからノートを開く */
  onOpen: (path: string) => void
}

const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')

/**
 * バックリンク (task #6)。
 *
 * サーバーが毎回 vault を走査して数えるので、外部エディタやエージェントが書いた直後でも
 * 最新になる。**開いているノートが変わるたびに取り直す**。
 */
function Backlinks({ path, onOpen }: { path: string; onOpen: (path: string) => void }): JSX.Element {
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null)

  useEffect(() => {
    let live = true
    setBacklinks(null)
    fetchBacklinks(path)
      .then((hits) => { if (live) setBacklinks(hits) })
      .catch(() => { if (live) setBacklinks([]) })
    return () => { live = false }
  }, [path])

  return (
    <section className="panel-section">
      <h2 className="panel-title">
        <Link2 size={13} /> バックリンク{backlinks === null ? '' : ` (${String(backlinks.length)})`}
      </h2>
      {backlinks === null ? (
        <p className="panel-note">読み込み中…</p>
      ) : backlinks.length === 0 ? (
        <p className="panel-note">このノートを指しているノートはありません</p>
      ) : (
        <ul className="backlink-list">
          {backlinks.map((hit) => (
            <li key={`${hit.path}:${String(hit.line)}:${hit.raw}`}>
              <button type="button" className="backlink" onClick={() => { onOpen(hit.path) }}>
                <span className="backlink-name">{baseNameOf(hit.path)}</span>
                <span className="backlink-snippet">{hit.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * 右サイドバー (task #2 の「開閉」まで)。
 *
 * 中身は今のところ開いているノートの素の事実だけ。
 * バックリンク (task #6) や詳細な情報 (task #35) はここへ足していく。
 */
export function InfoPanel({ open, onToggle, path, content, onOpen }: InfoPanelProps): JSX.Element {
  if (!open) {
    return (
      <aside className="panel-rail">
        <button type="button" className="icon-button" onClick={onToggle} aria-label="情報パネルを開く" title="情報パネルを開く">
          <PanelRightOpen size={18} />
        </button>
      </aside>
    )
  }

  const lines = content === null ? null : content.split('\n').length
  return (
    <aside className="panel">
      <div className="panel-header">
        <span className="panel-title">情報</span>
        <button type="button" className="icon-button" onClick={onToggle} aria-label="情報パネルを閉じる" title="情報パネルを閉じる">
          <PanelRightClose size={18} />
        </button>
      </div>
      {path === null ? (
        <p className="empty">ノートを選んでください</p>
      ) : (
        <>
          <dl className="panel-facts">
            <dt>パス</dt>
            <dd>{path}</dd>
            <dt>文字数</dt>
            <dd>{content === null ? '—' : content.length.toLocaleString()}</dd>
            <dt>行数</dt>
            <dd>{lines === null ? '—' : lines.toLocaleString()}</dd>
          </dl>
          <Backlinks path={path} onOpen={onOpen} />
        </>
      )}
    </aside>
  )
}
