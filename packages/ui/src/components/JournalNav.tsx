/**
 * ジャーナル日付ナビゲーション (サイドバー上部)。
 * journal-prev / journal-today / journal-next / journal-open-calendar (月グリッドカレンダーポップアップ)。
 * S2e8a4c-1: ListIcon/journal-list-pop を廃止し、CalendarIcon + 月グリッドポップアップに変更。
 */
import { useState, type JSX } from 'react';
import { journalDayOfWeek } from '@loamium/shared';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from '../icons.js';

export interface JournalNavProps {
  /** 今日の日付 (サーバー基準)。起動直後の未取得時は null */
  today: string | null;
  /** ナビゲーションの基準日 (開いているジャーナルの日付、なければ today) */
  baseDate: string | null;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onSelectDate: (date: string) => void;
}

/** 月グリッドカレンダーの日付行列を返す (null = 前/次月の穴埋め) */
function buildCalendarGrid(year: number, month: number): Array<string | null> {
  // month は 1-based
  const firstDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: Array<string | null> = Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(month).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    cells.push(`${String(year)}-${mm}-${dd}`);
  }
  // 末尾を 7 の倍数に揃える
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function JournalNav(props: JournalNavProps): JSX.Element {
  const { today, baseDate } = props;
  const navDisabled = baseDate === null;

  // カレンダーポップアップの開閉
  const [calOpen, setCalOpen] = useState(false);
  // 表示月 (初期値は baseDate or today の月)
  const initialYear = (): number => {
    const d = baseDate ?? today;
    return d !== null ? parseInt(d.slice(0, 4), 10) : new Date().getFullYear();
  };
  const initialMonth = (): number => {
    const d = baseDate ?? today;
    return d !== null ? parseInt(d.slice(5, 7), 10) : new Date().getMonth() + 1;
  };
  const [calYear, setCalYear] = useState(initialYear);
  const [calMonth, setCalMonth] = useState(initialMonth);

  const openCalendar = (): void => {
    // 毎回 baseDate/today の月を起点とする
    const d = baseDate ?? today;
    if (d !== null) {
      setCalYear(parseInt(d.slice(0, 4), 10));
      setCalMonth(parseInt(d.slice(5, 7), 10));
    }
    setCalOpen((v) => !v);
  };

  const prevMonth = (): void => {
    if (calMonth === 1) { setCalYear((y) => y - 1); setCalMonth(12); }
    else setCalMonth((m) => m - 1);
  };
  const nextMonth = (): void => {
    if (calMonth === 12) { setCalYear((y) => y + 1); setCalMonth(1); }
    else setCalMonth((m) => m + 1);
  };

  const grid = buildCalendarGrid(calYear, calMonth);
  const monthLabel = `${String(calYear)}-${String(calMonth).padStart(2, '0')}`;

  return (
    <nav className="journal-nav" data-testid="journal-nav" aria-label="ジャーナル日付ナビゲーション">
      <div className="journal-nav-label">Daily Journal</div>
      <div className="journal-nav-row">
        <button
          className="icon-btn"
          data-testid="journal-prev"
          title="前日のジャーナルへ"
          disabled={navDisabled}
          onClick={props.onPrev}
        >
          <ChevronLeftIcon />
        </button>
        <button
          className="journal-date-btn"
          data-testid="journal-today"
          title="今日のジャーナルを開く"
          onClick={props.onToday}
        >
          {today ?? '—'}
          {today !== null && <span className="dow">{journalDayOfWeek(today)}</span>}
        </button>
        <button
          className="icon-btn"
          data-testid="journal-next"
          title="翌日のジャーナルへ"
          disabled={navDisabled}
          onClick={props.onNext}
        >
          <ChevronRightIcon />
        </button>
        <button
          className="icon-btn"
          data-testid="journal-open-calendar"
          title="カレンダーでジャーナルを選ぶ"
          aria-expanded={calOpen}
          onClick={openCalendar}
        >
          <CalendarIcon />
        </button>
      </div>
      {calOpen && (
        <>
          {/* バックドロップ: カレンダー外クリックで閉じる */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
            onClick={() => setCalOpen(false)}
          />
          <div className="journal-calendar-popup" data-testid="journal-calendar-popup">
            <div className="jcal-header">
              <button className="icon-btn jcal-nav" title="前月" onClick={prevMonth}>
                <ChevronLeftIcon />
              </button>
              <span className="jcal-month-label">{monthLabel}</span>
              <button className="icon-btn jcal-nav" title="次月" onClick={nextMonth}>
                <ChevronRightIcon />
              </button>
            </div>
            <div className="jcal-dow-row">
              {['日', '月', '火', '水', '木', '金', '土'].map((d) => (
                <span key={d} className="jcal-dow">{d}</span>
              ))}
            </div>
            <div className="jcal-grid">
              {grid.map((date, idx) =>
                date === null ? (
                  <span key={`empty-${String(idx)}`} className="jcal-day jcal-day-empty" />
                ) : (
                  <button
                    key={date}
                    className={`jcal-day${date === today ? ' today' : ''}`}
                    data-testid="journal-cal-day"
                    data-date={date}
                    title={date}
                    onClick={() => {
                      setCalOpen(false);
                      props.onSelectDate(date);
                    }}
                  >
                    {parseInt(date.slice(8, 10), 10)}
                  </button>
                ),
              )}
            </div>
          </div>
        </>
      )}
    </nav>
  );
}
