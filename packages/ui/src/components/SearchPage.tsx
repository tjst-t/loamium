import { useEffect, useMemo, useState, type JSX } from 'react'
import { Hash, Search } from 'lucide-react'
import { fetchTags, searchNotes, type SearchHit, type TagCount, type TreeNode } from '../api'
import type { SearchParams } from '../route'

export interface SearchPageProps {
  params: SearchParams
  tree: TreeNode[]
  /** 条件を変える (URL に反映する) */
  onChange: (next: Partial<SearchParams>) => void
  /** ヒットを開く。needle は本文中で光らせる語 */
  onOpen: (path: string, needle: string) => void
}

const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')

/** ツリーからフォルダのパスだけを平坦に取り出す */
function foldersOf(tree: TreeNode[]): string[] {
  const out: string[] = []
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.type !== 'folder') continue
      out.push(node.path)
      walk(node.children ?? [])
    }
  }
  walk(tree)
  return out
}

/** 1 ノート分のヒット */
interface Group {
  path: string
  hits: SearchHit[]
}

function groupByNote(hits: SearchHit[]): Group[] {
  const groups = new Map<string, Group>()
  for (const hit of hits) {
    const group = groups.get(hit.path) ?? { path: hit.path, hits: [] }
    group.hits.push(hit)
    groups.set(hit.path, group)
  }
  return [...groups.values()]
}

/**
 * 詳細検索ページ (task #8)。
 *
 * パレット (Ctrl+K) が「思い出したノートへ飛ぶ」ためのものなのに対し、こちらは
 * **条件で絞って見渡す**ための画面。条件は URL に載るので共有・ブックマークできる。
 */
export function SearchPage({ params, tree, onChange, onOpen }: SearchPageProps): JSX.Element {
  const [hits, setHits] = useState<SearchHit[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tags, setTags] = useState<TagCount[]>([])
  const folders = useMemo(() => foldersOf(tree), [tree])

  useEffect(() => {
    fetchTags().then(setTags).catch(() => { setTags([]) })
  }, [])

  useEffect(() => {
    if (params.q.trim() === '' && params.tag === '' && params.folder === '') {
      setHits([])
      setTruncated(false)
      return undefined
    }
    let live = true
    setLoading(true)
    const timer = setTimeout(() => {
      searchNotes(params.q, { tag: params.tag, folder: params.folder })
        .then((result) => {
          if (!live) return
          setHits(result.hits)
          setTruncated(result.truncated)
          setLoading(false)
        })
        .catch(() => { if (live) { setHits([]); setLoading(false) } })
    }, 120)
    return () => { live = false; clearTimeout(timer) }
  }, [params.q, params.tag, params.folder])

  const groups = groupByNote(hits)
  const lineCount = hits.filter((hit) => hit.line > 0).length

  return (
    <div className="search-page">
      <div className="search-controls">
        <label className="search-field">
          <Search size={16} />
          <input
            type="search"
            value={params.q}
            placeholder="検索語 (空でもタグ・フォルダで絞れます)"
            aria-label="検索語"
            autoFocus
            onChange={(e) => { onChange({ q: e.target.value }) }}
          />
        </label>
        <label className="search-filter">
          フォルダ
          <select
            value={params.folder}
            aria-label="フォルダで絞り込む"
            onChange={(e) => { onChange({ folder: e.target.value }) }}
          >
            <option value="">すべて</option>
            {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
          </select>
        </label>
      </div>

      <div className="search-tags">
        {params.tag !== '' && (
          <button type="button" className="tag-pill is-active" onClick={() => { onChange({ tag: '' }) }}>
            <Hash size={12} />{params.tag} ×
          </button>
        )}
        {tags
          .filter((entry) => entry.tag !== params.tag)
          .map((entry) => (
            <button
              key={entry.tag}
              type="button"
              className="tag-pill"
              onClick={() => { onChange({ tag: entry.tag }) }}
            >
              <Hash size={12} />{entry.tag}<span className="tag-count">{entry.count}</span>
            </button>
          ))}
      </div>

      <p className="search-summary">
        {loading
          ? '検索中…'
          : `${String(groups.length)} ノート / ${String(lineCount)} 行${truncated ? ' (多いので途中まで)' : ''}`}
      </p>

      <ul className="search-results">
        {groups.map((group) => (
          <li key={group.path}>
            <h2 className="search-result-title">
              <button type="button" onClick={() => { onOpen(group.path, params.q) }}>
                {baseNameOf(group.path)}
                <span className="search-result-path">{group.path}</span>
                {group.hits.some((hit) => hit.kind === 'title') && (
                  <span className="search-result-badge">ノート名が一致</span>
                )}
              </button>
            </h2>
            <ul className="search-lines">
              {group.hits.filter((hit) => hit.line > 0).map((hit) => (
                <li key={`${hit.path}:${String(hit.line)}`}>
                  <button type="button" onClick={() => { onOpen(hit.path, hit.snippet.slice(hit.match.start, hit.match.start + hit.match.length) || params.q) }}>
                    <span className="search-line-no">{hit.line}</span>
                    <span className="search-line-text">{hit.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}
