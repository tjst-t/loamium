import type { VaultService } from './plugins/vault'
import type { NoteIndexService } from './plugins/note-index'
import type { SseService } from './plugins/sse'

declare module 'cordis' {
  interface Context {
    vault: VaultService
    noteIndex: NoteIndexService
    sse: SseService
  }
  interface Events {
    /** vault 上のファイルが変化した。リスナーは何本でも張れる */
    'vault/change'(path: string, op: 'upsert' | 'remove'): void
  }
}
export {}
