import { useEffect, useRef, useState, type JSX } from 'react'
import { Command } from 'cmdk'
import { FileText, Search } from 'lucide-react'
import { searchNotes, type SearchHit } from '../api'

export interface SearchPaletteProps {
  open: boolean
  onClose: () => void
  /** 選択されたヒットを開く。needle は本文中で光らせる語 */
  onPick: (path: string, needle: string) => void
}

/** 入力のたびに投げない。打ち終わりを待ってから 1 回だけ問い合わせる */
const DEBOUNCE_MS = 120

/**
 * Cmd/Ctrl+K の検索パレット。ノート名と本文を横断する。
 * 一覧の絞り込みは**サーバー側の検索結果をそのまま使う** (cmdk 側の
 * フィルタは切る)。スニペットやランキングを二重に持たないため。
 */
export function SearchPalette(props: SearchPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  // 開くたびに入力を空に戻す (前回の検索語が残っていると意図しない結果を開きやすい)
  useEffect(() => {
    if (props.open) { setQuery(''); setHits([]) }
  }, [props.open])

  // Command.Dialog を使わず自前で重ねているので、Escape も自前で拾う
  useEffect(() => {
    if (!props.open) return undefined
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); props.onClose() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [props])

  useEffect(() => {
    if (!props.open) return undefined
    if (query.trim() === '') { setHits([]); setLoading(false); return undefined }

    setLoading(true)
    const mine = ++seq.current
    const timer = setTimeout(() => {
      searchNotes(query)
        .then((result) => {
          // 遅れて返ってきた古い結果で新しい結果を上書きしない
          if (mine !== seq.current) return
          setHits(result.hits)
          setLoading(false)
        })
        .catch(() => { if (mine === seq.current) { setHits([]); setLoading(false) } })
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [props.open, query])

  if (!props.open) return null

  return (
    <div className="palette-backdrop" onPointerDown={props.onClose}>
      <div className="palette" onPointerDown={(e) => { e.stopPropagation() }}>
        <Command shouldFilter={false} loop label="ノートを検索">
          <div className="palette-input">
            <Search size={16} />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="ノート名と本文を検索…"
            />
            <kbd>Esc</kbd>
          </div>

          <Command.List className="palette-list">
            {query.trim() === '' ? (
              <Command.Empty className="palette-empty">検索語を入力してください</Command.Empty>
            ) : loading ? (
              <Command.Loading className="palette-empty">検索中…</Command.Loading>
            ) : hits.length === 0 ? (
              <Command.Empty className="palette-empty">一致するノートはありません</Command.Empty>
            ) : (
              hits.map((hit) => (
                <Command.Item
                  key={`${hit.path}:${hit.line}:${hit.match.start}`}
                  value={`${hit.path}:${hit.line}:${hit.match.start}`}
                  onSelect={() => { props.onPick(hit.path, query) }}
                  className="palette-item"
                >
                  <FileText size={14} />
                  <span className="palette-item-body">
                    <span className="palette-item-path">
                      {hit.path}
                      {hit.line > 0 && <span className="palette-item-line">:{hit.line}</span>}
                    </span>
                    <span className="palette-item-snippet">
                      {highlight(hit.snippet, hit.match)}
                    </span>
                  </span>
                  {hit.kind === 'title' && <span className="palette-item-kind">ノート名</span>}
                </Command.Item>
              ))
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  )
}

/** スニペット内のマッチ位置を <mark> で囲む。位置はサーバーが返した値をそのまま使う */
function highlight(snippet: string, match: SearchHit['match']): JSX.Element {
  const end = match.start + match.length
  return (
    <>
      {snippet.slice(0, match.start)}
      <mark>{snippet.slice(match.start, end)}</mark>
      {snippet.slice(end)}
    </>
  )
}
