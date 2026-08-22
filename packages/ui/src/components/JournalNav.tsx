import type { JSX } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'

export interface JournalNavProps {
  /** 表示中のジャーナルの日付 (YYYY-MM-DD) */
  date: string
  /** 日付式 (YYYY-MM-DD / today / -1d ...) を渡して移動する */
  onGo: (date: string) => void
}

const shift = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)
  return `${next.getFullYear()}-${`${next.getMonth() + 1}`.padStart(2, '0')}-${`${next.getDate()}`.padStart(2, '0')}`
}

/** ジャーナルの日付ナビ。前後移動と、OS のカレンダー (date input) からの直接指定 */
export function JournalNav(props: JournalNavProps): JSX.Element {
  return (
    <div className="journal-nav">
      <button
        type="button" className="icon-button" aria-label="前の日"
        onClick={() => { props.onGo(shift(props.date, -1)) }}
      >
        <ChevronLeft size={16} />
      </button>
      <label className="journal-date">
        <CalendarDays size={14} />
        <input
          type="date"
          aria-label="ジャーナルの日付"
          value={props.date}
          onChange={(e) => { if (e.target.value !== '') props.onGo(e.target.value) }}
        />
      </label>
      <button
        type="button" className="icon-button" aria-label="次の日"
        onClick={() => { props.onGo(shift(props.date, 1)) }}
      >
        <ChevronRight size={16} />
      </button>
      <button type="button" className="text-button" onClick={() => { props.onGo('today') }}>今日</button>
    </div>
  )
}
