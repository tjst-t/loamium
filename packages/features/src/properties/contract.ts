import type { Property, PropertyType } from '@loamium/shared'

/** properties 機能の REST 契約。**両側が import する**ので React も Node も含めない */
export interface PropertyKeyCount {
  key: string
  type: PropertyType
  count: number
}

export interface NoteProperties {
  path: string
  properties: Property[]
}

export const propertiesApi = {
  /** vault で使われているキー (補完に使う) */
  keys: (): string => '/api/properties/keys',
  /** そのノートのプロパティ */
  ofNote: (path: string): string => `/api/properties?path=${encodeURIComponent(path)}`,
  /** 1 つ書き換える (PUT) */
  edit: (): string => '/api/properties',
}
