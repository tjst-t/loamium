import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearNoteViewStates, forgetNoteViewState, getNoteViewState, renameNoteViewState, saveNoteViewState,
} from '../view-state'

beforeEach(() => { clearNoteViewStates() })

describe('ノートごとの表示状態', () => {
  it('保存したものが戻る (A → B → 戻る で復元できる)', () => {
    saveNoteViewState('a.md', { cursor: 42, scrollTop: 120 })
    saveNoteViewState('b.md', { cursor: 3, scrollTop: 0 })
    expect(getNoteViewState('a.md')).toEqual({ cursor: 42, scrollTop: 120 })
    expect(getNoteViewState('b.md')).toEqual({ cursor: 3, scrollTop: 0 })
  })

  it('知らないノートは undefined (復元しない)', () => {
    expect(getNoteViewState('never-opened.md')).toBeUndefined()
  })

  it('リネームに追従する', () => {
    saveNoteViewState('old.md', { cursor: 7, scrollTop: 9 })
    renameNoteViewState('old.md', 'new.md')
    expect(getNoteViewState('old.md')).toBeUndefined()
    expect(getNoteViewState('new.md')).toEqual({ cursor: 7, scrollTop: 9 })
  })

  it('削除したノートの状態は捨てる', () => {
    saveNoteViewState('gone.md', { cursor: 1, scrollTop: 1 })
    forgetNoteViewState('gone.md')
    expect(getNoteViewState('gone.md')).toBeUndefined()
  })
})
