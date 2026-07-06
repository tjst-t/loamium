/**
 * テンプレート選択パレット (S89a350-3)。
 *
 * ビジュアルの正: prototype/templates/picker.html。
 * 「新規ノート ▸ テンプレートから新規作成」から開く一覧。各項目に保存先パターンの
 * プレビューを出し、選択すると変数入力モーダル (TemplateModal) へ進む。
 * キーボード完結: ↑↓ 選択 / Enter 決定 / 1-9 直接選択 / Esc 閉じる。
 *
 * data-testid (prototype/TESTIDS.md 準拠):
 *   template-picker-backdrop / template-picker / template-picker-list
 *   template-item (data-template)
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { resolveTemplate, type TemplateSummary } from '@loamium/shared';
import { ChevronRightIcon, DocumentIcon } from '../icons.js';

interface TemplatePickerProps {
  templates: TemplateSummary[] | null;
  error: string | null;
  onSelect: (template: TemplateSummary) => void;
  onClose: () => void;
}

/** 保存先パターンのプレビュー: date/now は解決、未入力変数はトークンのまま表示。 */
function targetPreview(t: TemplateSummary): string {
  const pattern = t.target ?? t.name;
  const resolved = resolveTemplate(pattern, { date: new Date(), now: new Date() }).text;
  return /\.md$/i.test(resolved) ? resolved : `${resolved}.md`;
}

export function TemplatePicker(props: TemplatePickerProps): JSX.Element {
  const templates = props.templates ?? [];
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (sel >= templates.length && templates.length > 0) setSel(templates.length - 1);
  }, [templates.length, sel]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => (templates.length === 0 ? 0 : (s + 1) % templates.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => (templates.length === 0 ? 0 : (s - 1 + templates.length) % templates.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const t = templates[sel];
        if (t !== undefined) props.onSelect(t);
      } else if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        const t = templates[i];
        if (t !== undefined) {
          setSel(i);
          props.onSelect(t);
        }
      }
    },
    [props, sel, templates],
  );

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  return (
    <div
      className="palette-backdrop"
      data-testid="template-picker-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        className="palette"
        data-testid="template-picker"
        role="dialog"
        aria-label="テンプレートを選択"
        style={{ width: 600 }}
        tabIndex={-1}
        ref={listRef}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input-row">
          <span style={{ fontSize: 14, fontWeight: 600 }}>テンプレートから新規作成</span>
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-faint)' }}>
            templates/ · {templates.length} 件
          </span>
        </div>

        <div className="tpl-pick-list" data-testid="template-picker-list">
          {props.error !== null ? (
            <div className="palette-error">テンプレートを読み込めませんでした — {props.error}</div>
          ) : props.templates === null ? (
            <div className="palette-empty">読み込み中…</div>
          ) : templates.length === 0 ? (
            <div className="palette-empty">
              templates/ にテンプレートがありません。templates/ 配下に Markdown を作成してください。
            </div>
          ) : (
            templates.map((t, i) => (
              <button
                key={t.path}
                type="button"
                className={`tpl-pick-item${i === sel ? ' selected' : ''}`}
                data-testid="template-item"
                data-template={t.name}
                onMouseMove={() => {
                  if (sel !== i) setSel(i);
                }}
                onClick={() => props.onSelect(t)}
              >
                <span className="tpl-pick-ico">
                  <DocumentIcon />
                </span>
                <span className="tpl-pick-main">
                  <span className="tpl-pick-name">
                    {t.name}
                    {i < 9 && <span className="kbd-num">{i + 1}</span>}
                  </span>
                  {t.description !== undefined && (
                    <span className="tpl-pick-desc">{t.description}</span>
                  )}
                  <span className="tpl-pick-target" data-testid="template-item-target">
                    <span className="arrow">→</span>
                    {targetPreview(t)}
                  </span>
                  {t.vars.length > 0 && (
                    <span className="tpl-pick-vars">
                      {t.vars.map((v) => (
                        <span key={v.name} className="tpl-var-chip">
                          {v.label ?? v.name}
                          {v.required && <span className="req">*</span>}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="tpl-pick-go">
                  <ChevronRightIcon />
                </span>
              </button>
            ))
          )}
        </div>

        <div className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 選択
          </span>
          <span>
            <kbd>1</kbd>–<kbd>9</kbd> 直接選択
          </span>
          <span>
            <kbd>Enter</kbd> 決定
          </span>
          <span>
            <kbd>Esc</kbd> 閉じる
          </span>
        </div>
      </div>
    </div>
  );
}
