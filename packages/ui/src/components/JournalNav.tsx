/**
 * ジャーナル日付ナビゲーション (サイドバー上部)。
 * journal-prev / journal-today / journal-next / journal-open-list (+ 一覧ポップアップ)。
 */
import type { JSX } from 'react';
import { journalDayOfWeek } from '@loamium/shared';
import { ChevronLeftIcon, ChevronRightIcon, ListIcon } from '../icons.js';

export interface JournalEntry {
  date: string;
}

export interface JournalNavProps {
  /** 今日の日付 (サーバー基準)。起動直後の未取得時は null */
  today: string | null;
  /** ナビゲーションの基準日 (開いているジャーナルの日付、なければ today) */
  baseDate: string | null;
  /** 既存ジャーナルの一覧 (新しい順) */
  entries: JournalEntry[];
  listOpen: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onToggleList: () => void;
  onSelectDate: (date: string) => void;
}

export function JournalNav(props: JournalNavProps): JSX.Element {
  const { today, baseDate, entries, listOpen } = props;
  const navDisabled = baseDate === null;
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
          data-testid="journal-open-list"
          title="ジャーナル一覧"
          onClick={props.onToggleList}
        >
          <ListIcon />
        </button>
      </div>
      <div className="journal-list">
        {listOpen && (
          <div className="journal-list-pop" data-testid="journal-list">
            {entries.length === 0 ? (
              <div className="journal-list-item">
                <span className="dim">ジャーナルはまだありません</span>
              </div>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.date}
                  className={entry.date === today ? 'journal-list-item today' : 'journal-list-item'}
                  data-testid="journal-list-item"
                  data-date={entry.date}
                  onClick={() => props.onSelectDate(entry.date)}
                >
                  {entry.date}{' '}
                  <span className="dim">{entry.date === today ? '今日' : journalDayOfWeek(entry.date)}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
