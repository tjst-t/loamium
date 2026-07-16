/**
 * cron 式ビルダー。
 * パターン選択 + input[type=time] (ネイティブタイムピッカー) で操作でき、
 * 生成された cron 式をリアルタイム表示する。
 * カスタムモードでは raw テキスト入力にフォールバック。
 */
import { useEffect, useRef, useState, type JSX } from 'react';

type Pattern = 'daily' | 'weekly' | 'monthly' | 'hourly' | 'custom';

interface State {
  pattern: Pattern;
  hour: number;
  minute: number;
  /** 0=日, 1=月, 2=火, 3=水, 4=木, 5=金, 6=土 */
  dow: number;
  /** 1–31 */
  day: number;
  custom: string;
}

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** State → cron 式 */
function toCron(s: State): string {
  switch (s.pattern) {
    case 'daily':   return `${s.minute} ${s.hour} * * *`;
    case 'weekly':  return `${s.minute} ${s.hour} * * ${s.dow}`;
    case 'monthly': return `${s.minute} ${s.hour} ${s.day} * *`;
    case 'hourly':  return `${s.minute} * * * *`;
    case 'custom':  return s.custom;
  }
}

/** cron 式 → State (判定できなければ custom) */
function fromCron(expr: string): State {
  const base: State = { pattern: 'custom', hour: 8, minute: 0, dow: 1, day: 1, custom: expr };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return base;
  const [m, h, dom, mon, dw] = parts;

  const isNum = (s: string | undefined): s is string => s !== undefined && /^\d+$/.test(s);
  const isWild = (s: string | undefined) => s === '*';

  const minute = isNum(m) ? parseInt(m, 10) : null;
  const hour   = isNum(h) ? parseInt(h, 10) : null;
  const dayN   = isNum(dom) ? parseInt(dom, 10) : null;
  const dowN   = isNum(dw) ? parseInt(dw, 10) : null;

  if (isNum(m) && isWild(h) && isWild(dom) && isWild(mon) && isWild(dw) && minute !== null)
    return { ...base, pattern: 'hourly', minute };
  if (isNum(m) && isNum(h) && isWild(dom) && isWild(mon) && isWild(dw) && minute !== null && hour !== null)
    return { ...base, pattern: 'daily', minute, hour };
  if (isNum(m) && isNum(h) && isWild(dom) && isWild(mon) && isNum(dw) && minute !== null && hour !== null && dowN !== null)
    return { ...base, pattern: 'weekly', minute, hour, dow: dowN };
  if (isNum(m) && isNum(h) && isNum(dom) && isWild(mon) && isWild(dw) && minute !== null && hour !== null && dayN !== null)
    return { ...base, pattern: 'monthly', minute, hour, day: dayN };
  return { ...base, pattern: 'custom', custom: expr };
}

/** 人間が読みやすい説明文 */
function describe(s: State): string {
  const hm = `${pad2(s.hour)}:${pad2(s.minute)}`;
  switch (s.pattern) {
    case 'daily':   return `毎日 ${hm} に実行`;
    case 'weekly':  return `毎週${DOW_LABELS[s.dow]}曜日 ${hm} に実行`;
    case 'monthly': return `毎月${s.day}日 ${hm} に実行`;
    case 'hourly':  return `毎時 ${pad2(s.minute)}分 に実行`;
    case 'custom':  return s.custom.trim() ? '(カスタム式)' : '式を入力してください';
  }
}

// ── input[type=time] ラッパー ─────────────────────────────────────────────────

interface TimePickerProps {
  hour: number;
  minute: number;
  disabled: boolean;
  onChange: (hour: number, minute: number) => void;
}

function TimePicker({ hour, minute, disabled, onChange }: TimePickerProps): JSX.Element {
  return (
    <input
      type="time"
      className="param-input"
      value={`${pad2(hour)}:${pad2(minute)}`}
      disabled={disabled}
      style={{ width: 'auto' }}
      onChange={(e) => {
        const parts = e.target.value.split(':').map(Number);
        const h = parts[0], min = parts[1];
        if (h !== undefined && min !== undefined && !Number.isNaN(h) && !Number.isNaN(min)) onChange(h, min);
      }}
    />
  );
}

// ── 毎時間の「分」入力 ────────────────────────────────────────────────────────

interface MinutePickerProps {
  minute: number;
  disabled: boolean;
  onChange: (minute: number) => void;
}

function MinutePicker({ minute, disabled, onChange }: MinutePickerProps): JSX.Element {
  const [raw, setRaw] = useState(pad2(minute));
  useEffect(() => { setRaw(pad2(minute)); }, [minute]);

  function commit(str: string) {
    const n = parseInt(str, 10);
    if (!Number.isNaN(n)) { const v = clamp(n, 0, 59); setRaw(pad2(v)); onChange(v); }
    else setRaw(pad2(minute));
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>毎時</span>
      <input
        type="number"
        className="param-input"
        min={0}
        max={59}
        value={raw}
        disabled={disabled}
        style={{ width: 72, textAlign: 'center' }}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
      />
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>分</span>
    </span>
  );
}

// ── 日コンボボックス (テキスト入力 + ドロップダウン候補) ───────────────────────

function IconChevronDown(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

interface DayComboboxProps {
  value: number;
  disabled: boolean;
  onChange: (day: number) => void;
}

/** 1–31 日。キーボードで直接数字を打てて、▼ で候補一覧からも選べる。 */
function DayCombobox({ value, disabled, onChange }: DayComboboxProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(String(value));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setRaw(String(value)); }, [value]);

  // 外側クリックで閉じる + 確定
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  function commit(str: string): void {
    const n = parseInt(str, 10);
    if (!Number.isNaN(n)) { const v = clamp(n, 1, 31); setRaw(String(v)); onChange(v); }
    else setRaw(String(value));
  }

  return (
    <div
      className={`combobox${open ? ' open' : ''}`}
      ref={ref}
      style={{ flex: '0 0 auto', width: 92 }}
    >
      <input
        type="text"
        inputMode="numeric"
        className="param-input"
        value={raw}
        disabled={disabled}
        aria-label="日"
        onChange={(e) => setRaw(e.target.value.replace(/[^0-9]/g, ''))}
        onFocus={() => setOpen(true)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); setOpen(false); }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <button
        type="button"
        className="combo-toggle"
        aria-label="日の候補を表示"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <IconChevronDown />
      </button>
      <ul className="combo-menu" role="listbox">
        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
          <li
            key={d}
            role="option"
            aria-selected={d === value}
            tabIndex={-1}
            className={d === value ? 'sel' : ''}
            onMouseDown={(e) => { e.preventDefault(); onChange(d); setRaw(String(d)); setOpen(false); }}
          >
            {d}日
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── メインコンポーネント ──────────────────────────────────────────────────────

interface CronBuilderProps {
  value: string;
  onChange: (cron: string) => void;
  disabled?: boolean;
}

export function CronBuilder({ value, onChange, disabled = false }: CronBuilderProps): JSX.Element {
  const [state, setState] = useState<State>(() => fromCron(value));

  useEffect(() => {
    if (toCron(state) !== value) setState(fromCron(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function apply(patch: Partial<State>) {
    const next = { ...state, ...patch };
    setState(next);
    onChange(toCron(next));
  }

  const cron = toCron(state);
  const hasTime = state.pattern === 'daily' || state.pattern === 'weekly' || state.pattern === 'monthly';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>

        {/* パターン */}
        <select
          className="param-input"
          value={state.pattern}
          disabled={disabled}
          style={{ width: 'auto' }}
          onChange={(e) => {
            const pattern = e.target.value as Pattern;
            apply(pattern === 'custom' ? { pattern, custom: cron } : { pattern });
          }}
        >
          <option value="daily">毎日</option>
          <option value="weekly">毎週</option>
          <option value="monthly">毎月</option>
          <option value="hourly">毎時間</option>
          <option value="custom">カスタム</option>
        </select>

        {/* 毎週: 曜日 */}
        {state.pattern === 'weekly' && (
          <select
            className="param-input"
            value={state.dow}
            disabled={disabled}
            style={{ width: 'auto' }}
            onChange={(e) => apply({ dow: Number(e.target.value) })}
          >
            {DOW_LABELS.map((label, i) => (
              <option key={i} value={i}>{label}曜日</option>
            ))}
          </select>
        )}

        {/* 毎月: 日 (キーボード入力 + 候補ドロップダウン) */}
        {state.pattern === 'monthly' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <DayCombobox
              value={state.day}
              disabled={disabled}
              onChange={(d) => apply({ day: d })}
            />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>日</span>
          </span>
        )}

        {/* 時刻: ネイティブタイムピッカー */}
        {hasTime && (
          <TimePicker
            hour={state.hour}
            minute={state.minute}
            disabled={disabled}
            onChange={(h, min) => apply({ hour: h, minute: min })}
          />
        )}

        {/* 毎時間: 分のみ */}
        {state.pattern === 'hourly' && (
          <MinutePicker
            minute={state.minute}
            disabled={disabled}
            onChange={(min) => apply({ minute: min })}
          />
        )}

        {/* カスタム: raw cron */}
        {state.pattern === 'custom' && (
          <input
            className="param-input"
            type="text"
            value={state.custom}
            disabled={disabled}
            placeholder="分 時 日 月 曜"
            style={{ minWidth: 180, fontFamily: 'var(--font-mono, monospace)' }}
            onChange={(e) => apply({ custom: e.target.value })}
          />
        )}
      </div>

      {/* 説明文 + cron 式 */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 12.5 }}>
        <span style={{ color: 'var(--text-muted)' }}>{describe(state)}</span>
        <code style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: 5,
          padding: '1px 7px',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 11.5,
          color: 'var(--text-faint)',
          flexShrink: 0,
        }}>{cron}</code>
      </div>
    </div>
  );
}
