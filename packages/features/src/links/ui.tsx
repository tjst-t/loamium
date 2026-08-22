import { useEffect, useState, type JSX } from 'react'
import { Link2 } from 'lucide-react'
import { apiJson } from '@loamium/ui/src/api'
import { defineUiFeature, useShell } from '@loamium/ui/src/feature'
import { linksApi, type Backlink } from './contract'
import { wikilink } from './wikilink'

const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')

/**
 * バックリンク (task #6)。
 *
 * サーバーが毎回 vault を走査して数えるので、外部エディタやエージェントが書いた直後でも
 * 最新になる。**開いているノートが変わるたびに取り直す**。
 */
function Backlinks({ path }: { path: string }): JSX.Element {
  const { openNote } = useShell()
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null)

  useEffect(() => {
    let live = true
    setBacklinks(null)
    apiJson<{ backlinks: Backlink[] }>(linksApi.backlinks(path))
      .then((body) => { if (live) setBacklinks(body.backlinks) })
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
              <button type="button" className="backlink" onClick={() => { openNote(hit.path) }}>
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

/** WikiLink `[[…]]` とバックリンク (task #4 / #5 / #6) */
export default defineUiFeature({
  name: 'links',
  requires: 'links',
  // ⚠️ 補完は Enter / Tab をリストのコマンドより先に拾う必要がある
  editor: { order: 'before-preset', plugins: wikilink },
  panelSection: ({ path }) => <Backlinks path={path} />,
})
