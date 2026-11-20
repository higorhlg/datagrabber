import { Eye, FileCode2, SquareTerminal, Table2, X } from 'lucide-react';
import type { ConnectionSummary } from '../lib/types.ts';
import { type Tab, tabLabel } from './tabs.ts';

type EditorTabsProps = {
  tabs: Tab[];
  activeKey: string | undefined;
  connectionOf: (id: string) => ConnectionSummary | undefined;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
};

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === 'console') return <SquareTerminal size={14} />;
  if (tab.kind === 'ddl') return <FileCode2 size={14} />;
  return tab.relation.kind.includes('view') ? <Eye size={14} /> : <Table2 size={14} />;
}

/** The tab strip above the editor area; middle-click closes a tab. */
export function EditorTabs({ tabs, activeKey, connectionOf, onActivate, onClose }: EditorTabsProps) {
  return (
    <div className="editor-tabs" role="tablist">
      {tabs.map((tab) => {
        const connection = connectionOf(tab.connectionId);
        if (!connection) return null;
        const label = tabLabel(tab, connection);
        return (
          <div
            key={tab.key}
            role="tab"
            aria-selected={tab.key === activeKey}
            className={`editor-tab${tab.key === activeKey ? ' active' : ''}`}
            style={{ ['--conn-color' as string]: connection.color }}
            onClick={() => onActivate(tab.key)}
            onAuxClick={(e) => e.button === 1 && onClose(tab.key)}
            title={label}
          >
            <span className="tab-icon">
              <TabIcon tab={tab} />
            </span>
            <span className="tab-label">{label}</span>
            <button
              type="button"
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.key);
              }}
              aria-label={`Close ${label}`}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
