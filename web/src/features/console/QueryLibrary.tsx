import { useEffect, useState } from 'react';
import { Pencil, Play, Star, TextCursorInput, Trash2, X } from 'lucide-react';
import type { HistoryEntry, SavedQuery } from '../../../shared/types.ts';
import { api } from '../api.ts';

type QueryLibraryProps = {
  connectionId: string;
  connectionName: string;
  /** Bumped by the console after each run or save, to reload the lists. */
  refreshKey: number;
  initialTab?: 'history' | 'saved';
  /** Set by the console's ★ Save button: opens the naming form for this SQL. */
  saveRequest?: { sql: string; nonce: number };
  onInsert: (sql: string) => void;
  onRun: (sql: string) => void;
  onClose: () => void;
  notify: (message: string) => void;
};

/** Formats an ISO timestamp as a short local time, with the date when it isn't today. */
function when(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Per-database query library: everything run on this connection (History) and the queries the
 * user starred to keep (Saved). Each entry can be inserted into the console or run directly.
 */
export function QueryLibrary({ connectionId, connectionName, refreshKey, initialTab = 'history', saveRequest, onInsert, onRun, onClose, notify }: QueryLibraryProps) {
  const [tab, setTab] = useState(initialTab);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [search, setSearch] = useState('');
  const [naming, setNaming] = useState<{ sql: string; name: string; id?: string }>();
  const [localKey, setLocalKey] = useState(0);

  useEffect(() => {
    api.history(connectionId).then(setHistory).catch(() => setHistory([]));
    api.savedQueries(connectionId).then(setSaved).catch(() => setSaved([]));
  }, [connectionId, refreshKey, localKey]);

  useEffect(() => {
    if (saveRequest) setNaming({ sql: saveRequest.sql, name: '' });
  }, [saveRequest?.nonce]);

  const needle = search.trim().toLowerCase();
  const visibleHistory = needle ? history.filter((e) => e.sql.toLowerCase().includes(needle)) : history;
  const visibleSaved = needle ? saved.filter((q) => q.name.toLowerCase().includes(needle) || q.sql.toLowerCase().includes(needle)) : saved;
  const savedSql = new Set(saved.map((q) => q.sql.trim()));

  const commitName = async () => {
    if (!naming) return;
    try {
      if (naming.id) await api.renameSavedQuery(naming.id, naming.name);
      else await api.saveQuery(connectionId, naming.name, naming.sql);
      notify(naming.id ? 'Renamed' : `Saved to ${connectionName}`);
      setNaming(undefined);
      setTab('saved');
      setLocalKey((k) => k + 1);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const remove = async (query: SavedQuery) => {
    await api.deleteSavedQuery(query.id);
    setLocalKey((k) => k + 1);
  };

  return (
    <aside className="library" data-testid="query-library">
      <div className="library-head">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History <span className="muted">{history.length}</span></button>
          <button role="tab" aria-selected={tab === 'saved'} className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')} data-testid="saved-tab">Saved <span className="muted">{saved.length}</span></button>
        </div>
        <button className="tool" onClick={onClose} aria-label="Close library"><X size={14} /></button>
      </div>
      <input className="library-search" placeholder={tab === 'history' ? 'Search history…' : 'Search saved queries…'} value={search} onChange={(e) => setSearch(e.target.value)} />
      {naming && (
        <form className="name-form" onSubmit={(e) => { e.preventDefault(); commitName(); }}>
          <input autoFocus value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} placeholder="Name this query" data-testid="saved-name" />
          <button className="primary small-btn" type="submit">Save</button>
          <button className="ghost small-btn" type="button" onClick={() => setNaming(undefined)}>Cancel</button>
        </form>
      )}
      <div className="library-list">
        {tab === 'history' && visibleHistory.length === 0 && <p className="muted small pad">Queries you run on {connectionName} show up here.</p>}
        {tab === 'history' &&
          visibleHistory.map((entry) => (
            <div key={entry.id} className={`library-item${entry.ok ? '' : ' failed'}`} data-testid="history-item">
              <div className="library-meta">
                <span>{when(entry.at)} · {entry.ok ? `${entry.durationMs} ms${entry.rowCount !== null ? ` · ${entry.rowCount} rows` : ''}` : 'failed'}</span>
                <span className="item-actions">
                  <button className="tool" title="Run again" onClick={() => onRun(entry.sql)}><Play size={13} /></button>
                  <button className="tool" title="Insert into console" onClick={() => onInsert(entry.sql)}><TextCursorInput size={13} /></button>
                  <button className={`tool${savedSql.has(entry.sql.trim()) ? ' starred' : ''}`} title="Save (star) this query" onClick={() => setNaming({ sql: entry.sql, name: '' })} data-testid="star"><Star size={13} /></button>
                </span>
              </div>
              <code onDoubleClick={() => onInsert(entry.sql)} title="Double-click to insert into the console">{entry.sql.length > 300 ? `${entry.sql.slice(0, 300)}…` : entry.sql}</code>
            </div>
          ))}
        {tab === 'saved' && visibleSaved.length === 0 && <p className="muted small pad">Star a query in History (or use ★ Save in the console toolbar) to keep it here.</p>}
        {tab === 'saved' &&
          visibleSaved.map((query) => (
            <div key={query.id} className="library-item" data-testid="saved-item">
              <div className="library-meta">
                <strong className="saved-name">{query.name}</strong>
                <span className="item-actions">
                  <button className="tool" title="Run" onClick={() => onRun(query.sql)} data-testid="run-saved"><Play size={13} /></button>
                  <button className="tool" title="Insert into console" onClick={() => onInsert(query.sql)}><TextCursorInput size={13} /></button>
                  <button className="tool" title="Rename" onClick={() => setNaming({ sql: query.sql, name: query.name, id: query.id })}><Pencil size={13} /></button>
                  <button className="tool danger" title="Delete" onClick={() => remove(query)}><Trash2 size={13} /></button>
                </span>
              </div>
              <code onDoubleClick={() => onInsert(query.sql)} title="Double-click to insert into the console">{query.sql.length > 300 ? `${query.sql.slice(0, 300)}…` : query.sql}</code>
            </div>
          ))}
      </div>
    </aside>
  );
}
