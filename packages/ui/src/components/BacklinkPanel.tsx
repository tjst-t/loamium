/**
 * バックリンクパネル (右ペイン) のシェル。
 *
 * 3 ペインレイアウトの器と開閉トグルのみを実装する。実データ
 * (backlink-count / backlink-item) の結線は S6fbf45-2 のスコープ
 * (docs/sprint-logs/Sa704c3/decisions.json 参照)。
 */
import type { JSX } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, LinkIcon } from '../icons.js';

export interface BacklinkPanelProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function BacklinkPanel({ collapsed, onToggle }: BacklinkPanelProps): JSX.Element {
  return (
    <aside className={collapsed ? 'panel collapsed' : 'panel'} data-testid="backlink-panel">
      <div className="panel-header">
        {!collapsed && <span className="label">バックリンク</span>}
        <button
          className="icon-btn"
          data-testid="backlink-panel-toggle"
          title={collapsed ? 'パネルを開く' : 'パネルを閉じる'}
          onClick={onToggle}
        >
          {collapsed ? <ChevronLeftIcon /> : <ChevronRightIcon />}
        </button>
      </div>
      {!collapsed && (
        <div className="panel-body">
          <div className="panel-empty" data-testid="backlink-empty">
            <LinkIcon />
            <br />
            バックリンクはまだ利用できません。
            <br />
            ほかのノートから <code>[[ノート名]]</code> でリンクすると、ここに参照元が表示される予定です。
          </div>
        </div>
      )}
    </aside>
  );
}
