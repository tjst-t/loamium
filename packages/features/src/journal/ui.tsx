import { useRef, type JSX } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { defineUiFeature, useShell } from '@loamium/ui/src/feature'

export interface JournalCardProps {
  /** カードが指している日付 (YYYY-MM-DD) */
  date: string
  /** 今その日のジャーナルを開いているか。開いていればカードを現在地として強調する */
  active: boolean
  /** 日付式 (YYYY-MM-DD / today) を渡して移動する */
  onGo: (date: string) => void
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const

const parts = (date: string): { y: number; m: number; d: number; w: string } => {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number)
  return { y, m, d, w: WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? '' }
}

const shift = (date: string, days: number): string => {
  const { y, m, d } = parts(date)
  const next = new Date(y, m - 1, d + days)
  return `${next.getFullYear()}-${`${next.getMonth() + 1}`.padStart(2, '0')}-${`${next.getDate()}`.padStart(2, '0')}`
}

const todayISO = (): string => {
  const n = new Date()
  return `${n.getFullYear()}-${`${n.getMonth() + 1}`.padStart(2, '0')}-${`${n.getDate()}`.padStart(2, '0')}`
}

/**
 * サイドバーのジャーナル入口。**着地 (今日) と日付移動を 1 枚に統合する。**
 * 本文の上に別のバーを出すとエディタの領域を削り、ノートとジャーナルで
 * ヘッダの高さが変わってしまうため、ナビはサイドバーに置く。
 */
function JournalCard(props: JournalCardProps): JSX.Element {
  const picker = useRef<HTMLInputElement>(null)
  const { y, m, d, w } = parts(props.date)
  const isToday = props.date === todayISO()

  // ネイティブのカレンダーを開く。input 自体は透明で重ねてあるので、
  // showPicker が使えない環境ではそのままクリックが input に届く
  const openPicker = (): void => {
    const el = picker.current
    if (el === null) return
    try {
      el.showPicker()
    } catch {
      el.focus()
    }
  }

  return (
    <section className="journal-card" aria-current={props.active} aria-label="デイリージャーナル">
      <div className="journal-card-head">
        <CalendarDays size={14} />
        <span className="journal-card-title">ジャーナル</span>
        {!isToday && (
          <button type="button" className="journal-card-today" onClick={() => { props.onGo('today') }}>
            今日へ
          </button>
        )}
      </div>

      <div className="journal-card-nav">
        <button
          type="button" className="journal-card-arrow" aria-label="前の日"
          onClick={() => { props.onGo(shift(props.date, -1)) }}
        >
          <ChevronLeft size={16} />
        </button>

        <span className="journal-card-datewrap">
          <button
            type="button"
            className="journal-card-date"
            aria-label={`日付を選ぶ (現在: ${props.date})`}
            onClick={openPicker}
          >
            <span className="journal-card-date-main">{m}月{d}日</span>
            <span className="journal-card-date-sub">
              {w}曜日 · {y}
              {isToday && <span className="journal-card-date-today"> · 今日</span>}
            </span>
          </button>
          <input
            ref={picker}
            type="date"
            className="journal-card-picker"
            tabIndex={-1}
            aria-hidden="true"
            value={props.date}
            onChange={(e) => { if (e.target.value !== '') props.onGo(e.target.value) }}
          />
        </span>

        <button
          type="button" className="journal-card-arrow" aria-label="次の日"
          onClick={() => { props.onGo(shift(props.date, 1)) }}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  )
}


/** `journals/YYYY-MM-DD.md` から日付を取り出す。ジャーナル以外なら null */
const journalDateOf = (path: string | null): string | null =>
  (path === null ? null : /^journals\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1] ?? null)

/** デイリージャーナル (task #3)。VISION のジャーナル中心のワークフローの入口 */
function JournalEntry(): JSX.Element {
  const { currentPath, openJournal } = useShell()
  const date = journalDateOf(currentPath)
  return <JournalCard date={date ?? todayISO()} active={date !== null} onGo={openJournal} />
}

export default defineUiFeature({
  name: 'journal',
  requires: 'journal',
  sidebarItem: () => <JournalEntry />,
  // 起動時の着地とは別に、いつでも今日へ戻れるようにする
  commands: (shell) => [
    { id: 'journal.today', title: '今日のジャーナルを開く', keys: 'Mod+Shift+d', run: () => { shell.openJournal() } },
  ],
})
