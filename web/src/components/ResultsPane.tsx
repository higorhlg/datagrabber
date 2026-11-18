import { useState } from 'react';
import type { QueryError, QueryResult } from '../../../shared/types.ts';
import { toCsv, toInsertSql, toJson, toTsv } from '../export.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { Modal } from './Modal.tsx';
import { LoadingMessage, ProgressBar } from './Loading.tsx';
import { ResultsGrid } from './ResultsGrid.tsx';

export type ResultTab = {
  id: string;
  label: string;
  sql: string;
  status: 'running' | 'done' | 'error';
  result?: QueryResult;
  error?: QueryError;
};

type ResultsPaneProps = {
  tabs: ResultTab[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onSaveFile: (fileName: string, contents: string) => void;
  notify: (message: string) => void;
  /** Cancels the running statement (shown while a tab is running). */
  onCancel: () => void;
};

type ValueView = { name: string; type: string; value: string | null };

/** Pretty-prints JSON values; other values are shown as-is. */
function formatValue(view: ValueView): string {
  if (view.value === null) return 'NULL';
  if (/^jsonb?$/.test(view.type)) {
    try {
      return JSON.stringify(JSON.parse(view.value), null, 2);
    } catch {
      return view.value;
    }
  }
  return view.value;
}

/** Tabs of statement results with a status line, filter, copy/export menu and value viewer. */
export function ResultsPane({ tabs, activeId, onSelect, onSaveFile, notify, onCancel }: ResultsPaneProps) {
  const [filter, setFilter] = useState('');
  const [selectedValue, setSelectedValue] = useState<{ name?: string; value: string | null | undefined }>();
  const [viewing, setViewing] = useState<ValueView>();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>();
  const active = tabs.find((t) => t.id === activeId) ?? tabs.at(-1);

  if (tabs.length === 0) {
    return (
      <section className="results empty">
        <p className="muted">Run a statement with <kbd>⌘</kbd><kbd>↵</kbd> (statement at cursor or selection) or <kbd>⇧</kbd><kbd>⌘</kbd><kbd>↵</kbd> (whole console).</p>
      </section>
    );
  }

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    notify(`Copied ${what}`);
  };

  const openExportMenu = (x: number, y: number, result: QueryResult) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    setMenu({
      x,
      y,
      items: [
        { label: 'Copy as TSV (for spreadsheets)', onSelect: () => copy(toTsv(result), `${result.rows.length} rows as TSV`) },
        { label: 'Copy as CSV', onSelect: () => copy(toCsv(result), `${result.rows.length} rows as CSV`) },
        { label: 'Copy as JSON', onSelect: () => copy(toJson(result), `${result.rows.length} rows as JSON`) },
        { label: 'Copy as INSERT statements', onSelect: () => copy(toInsertSql(result, 'my_table'), 'INSERT statement') },
        { label: 'Save CSV to Downloads', onSelect: () => onSaveFile(`datagrabber-${stamp}.csv`, toCsv(result)) },
        { label: 'Save JSON to Downloads', onSelect: () => onSaveFile(`datagrabber-${stamp}.json`, toJson(result)) },
      ],
    });
  };

  return (
    <section className="results">
      <div className="results-tabs" role="tablist">
        {tabs.map((tab) => (
          <button key={tab.id} role="tab" aria-selected={tab.id === active?.id} className={`results-tab ${tab.status}${tab.id === active?.id ? ' active' : ''}`} onClick={() => onSelect(tab.id)} title={tab.sql}>
            {tab.status === 'running' && <span className="spinner" />}
            {tab.status === 'error' && <span className="err-dot">!</span>}
            {tab.label}
          </button>
        ))}
      </div>
      <ProgressBar active={tabs.some((t) => t.status === 'running')} />
      {active?.status === 'running' && (
        <div className="running-state" data-testid="running">
          <LoadingMessage>Running {active.label.replace(/^\d+: /, '')}</LoadingMessage>
          <button className="ghost small danger" onClick={onCancel}>Cancel</button>
        </div>
      )}
      {active?.status === 'error' && active.error && (
        <div className="query-error" data-testid="query-error">
          <strong>{active.error.code ? `[${active.error.code}] ` : ''}{active.error.message}</strong>
          {active.error.detail && <p>Detail: {active.error.detail}</p>}
          {active.error.hint && <p>Hint: {active.error.hint}</p>}
          <pre>{active.sql}</pre>
        </div>
      )}
      {active?.status === 'done' && active.result && (
        <>
          <div className="results-toolbar">
            <span className="results-status" data-testid="results-status">
              {active.result.columns.length > 0
                ? `${active.result.rows.length.toLocaleString()} row${active.result.rows.length === 1 ? '' : 's'}${active.result.truncated ? ' (limit reached — more available)' : ''}`
                : active.result.command}
              <span className="muted"> · {active.result.durationMs} ms</span>
            </span>
            {active.result.columns.length > 0 && (
              <>
                <input className="results-filter" placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <button className="ghost small" onClick={(e) => openExportMenu(e.clientX, e.clientY, active.result!)}>Copy / Export ▾</button>
              </>
            )}
          </div>
          <ResultsGrid
            result={active.result}
            filter={filter}
            onSelectValue={(value, name) => setSelectedValue({ value, name })}
            onOpenValue={(value, name, type) => setViewing({ value, name, type })}
          />
          {selectedValue && selectedValue.value !== undefined && (
            <div className="value-bar mono" title="Double-click a cell (or press Enter) to open it">
              <span className="muted">{selectedValue.name}:</span> {selectedValue.value === null ? <em className="muted">NULL</em> : selectedValue.value.slice(0, 500)}
            </div>
          )}
        </>
      )}
      {viewing && (
        <Modal title={`${viewing.name} (${viewing.type})`} onClose={() => setViewing(undefined)} wide footer={<><span className="spacer" /><button className="ghost" onClick={() => copy(viewing.value ?? '', 'value')}>Copy</button><button className="primary" onClick={() => setViewing(undefined)}>Close</button></>}>
          <pre className="value-viewer">{formatValue(viewing)}</pre>
        </Modal>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(undefined)} />}
    </section>
  );
}
