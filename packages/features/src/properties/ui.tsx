import { useEffect, useMemo, useState, type JSX } from 'react'
import { Tags as TagsIcon, Plus, X } from 'lucide-react'
import { apiJson } from '@loamium/ui/src/api'
import { defineUiFeature, useShell } from '@loamium/ui/src/feature'
import {
  applyPropertyEdit, readProperties,
  type Property, type PropertyEdit, type PropertyType,
} from '@loamium/shared'
import { propertiesApi, type PropertyKeyCount } from './contract'

/**
 * frontmatter プロパティ (task #17)。
 *
 * **エディタの中には出さない。** frontmatter はデータモデルの第一級市民であって
 * 本文ではない (VISION / ADR-0035)。ここは右の情報パネルの一節。
 *
 * 書き込みは 1 キーずつ REST を叩き、**画面はローカルで同じ変換をかけて合わせる**
 * (読み直すとエディタが作り直され、カーソルとスクロールが飛ぶため)。
 */

const TYPE_LABEL: Record<PropertyType, string> = {
  text: 'テキスト', number: '数値', date: '日付', boolean: '真偽', list: 'リスト', tags: 'タグ',
}
const TYPES = Object.keys(TYPE_LABEL) as PropertyType[]

const listText = (value: Property['value']): string => (Array.isArray(value) ? value.join(', ') : String(value ?? ''))
const toList = (text: string): string[] => text.split(',').map((s) => s.trim()).filter((s) => s !== '')

function Row({ property, onEdit }: { property: Property; onEdit: (edit: PropertyEdit) => void }): JSX.Element {
  const { key, type } = property
  const [draft, setDraft] = useState(() => (type === 'list' || type === 'tags' ? listText(property.value) : String(property.value ?? '')))
  // 外から (別の書き手やタイプ変更で) 値が変わったら追従する
  useEffect(() => {
    setDraft(type === 'list' || type === 'tags' ? listText(property.value) : String(property.value ?? ''))
  }, [property.value, type])

  // ⚠️ キー名は **1 文字ごとに送らない。** 送ると 1 打鍵で行が別のキーになり、
  //    入力欄が作り直されて 2 文字目が打てない (実機で発生)。確定はフォーカスを外したとき
  const [keyDraft, setKeyDraft] = useState(key)
  useEffect(() => { setKeyDraft(key) }, [key])

  const commit = (text: string): void => {
    const value = type === 'list' || type === 'tags' ? toList(text) : text
    onEdit({ key, value: { type, value } })
  }

  return (
    <div className="property-row">
      <div className="property-key">
        <input
          className="property-key-input"
          value={keyDraft}
          aria-label={`${key} のキー名`}
          onChange={(e) => { setKeyDraft(e.target.value) }}
          onBlur={() => {
            const next = keyDraft.trim()
            if (next === '' || next === key) setKeyDraft(key)
            else onEdit({ key, renameTo: next })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
        <select
          className="property-type"
          value={type}
          aria-label={`${key} の型`}
          onChange={(e) => {
            const next = e.target.value as PropertyType
            const value = next === 'list' || next === 'tags' ? toList(draft) : draft
            onEdit({ key, value: { type: next, value } })
          }}
        >
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div className="property-value">
        {type === 'boolean' ? (
          <label className="property-bool">
            <input
              type="checkbox"
              checked={property.value === true}
              aria-label={`${key} の値`}
              onChange={(e) => { onEdit({ key, value: { type, value: e.target.checked } }) }}
            />
            <span>{property.value === true ? 'true' : 'false'}</span>
          </label>
        ) : (
          <input
            className="property-input"
            type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
            value={draft}
            aria-label={`${key} の値`}
            placeholder={type === 'list' || type === 'tags' ? 'カンマ区切り' : ''}
            onChange={(e) => { setDraft(e.target.value) }}
            onBlur={(e) => { commit(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
        )}
        <button
          type="button"
          className="property-remove"
          title={`${key} を削除`}
          aria-label={`${key} を削除`}
          onClick={() => { onEdit({ key, remove: true }) }}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}

/** キーを先に決めてから値を入れる (Obsidian と同じ順番。型はキーから当てる) */
function AddRow({ keys, taken, onAdd }: {
  keys: PropertyKeyCount[]
  taken: readonly string[]
  onAdd: (key: string, type: PropertyType) => void
}): JSX.Element {
  const [key, setKey] = useState('')
  const suggestions = keys.filter((k) => !taken.includes(k.key))

  const add = (): void => {
    const name = key.trim()
    if (name === '') return
    onAdd(name, suggestions.find((k) => k.key === name)?.type ?? (name === 'tags' ? 'tags' : 'text'))
    setKey('')
  }

  return (
    <div className="property-add">
      <input
        className="property-input"
        list="loamium-property-keys"
        value={key}
        placeholder="プロパティを追加"
        aria-label="プロパティを追加"
        onChange={(e) => { setKey(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
      />
      <datalist id="loamium-property-keys">
        {suggestions.map((k) => <option key={k.key} value={k.key}>{TYPE_LABEL[k.type]}</option>)}
      </datalist>
      <button type="button" className="property-add-button" onClick={add} aria-label="追加">
        <Plus size={13} />
      </button>
    </div>
  )
}

function Properties({ path }: { path: string }): JSX.Element {
  const { content, patchContent } = useShell()
  const [keys, setKeys] = useState<PropertyKeyCount[]>([])
  const [error, setError] = useState<string | null>(null)
  const properties = useMemo(() => (content === null ? [] : readProperties(content)), [content])

  useEffect(() => {
    let live = true
    apiJson<{ keys: PropertyKeyCount[] }>(propertiesApi.keys())
      .then((body) => { if (live) setKeys(body.keys) })
      .catch(() => { /* 補完が出ないだけ。編集は続けられる */ })
    return () => { live = false }
  }, [path, content])

  const edit = (change: PropertyEdit): void => {
    if (content === null) return
    // 画面はローカルで先に合わせる (読み直すとエディタが作り直される)
    patchContent(applyPropertyEdit(content, change))
    setError(null)
    apiJson(propertiesApi.edit(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, ...change, ...(change.value ? { type: change.value.type, value: change.value.value } : {}) }),
    }).catch(() => { setError('保存できませんでした') })
  }

  return (
    <section className="panel-section">
      <h2 className="panel-title"><TagsIcon size={13} /> プロパティ</h2>
      {properties.length === 0 && <p className="panel-note">まだありません</p>}
      {properties.map((property) => (
        <Row key={property.key} property={property} onEdit={edit} />
      ))}
      <AddRow
        keys={keys}
        taken={properties.map((p) => p.key)}
        onAdd={(key, type) => { edit({ key, value: { type, value: type === 'list' || type === 'tags' ? [] : '' } }) }}
      />
      {error !== null && <p className="panel-note is-flag">{error}</p>}
    </section>
  )
}

export default defineUiFeature({
  name: 'properties',
  requires: 'properties',
  panelSection: ({ path }) => <Properties path={path} />,
})
