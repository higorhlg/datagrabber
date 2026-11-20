import {
  ArrowDownWideNarrow,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Download,
  Filter,
  RefreshCw,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../../lib/api.ts';
import { toCsv, toInsertSql, toJson, toTsv } from '../../lib/export.ts';
import { quoteIdent } from '../../lib/monaco/completion.ts';
import type { ConnectionSummary, QueryError, QueryResult, RelationInfo } from '../../lib/types.ts';
import { ContextMenu, type MenuItem } from '../../ui/ContextMenu.tsx';
import { ElapsedLabel, LoadingMessage, ProgressBar, SkeletonGrid, Spinner } from '../../ui/Loading.tsx';
import { Modal } from '../../ui/Modal.tsx';
import { ResultsGrid, type ServerSort } from '../../ui/ResultsGrid.tsx';
import { DdlViewer } from './DdlViewer.tsx';

const PAGE_SIZES = [100, 500, 1000, 5000];

type TableViewProps = {
  connection: ConnectionSummary;
  schema: string;
  relation: RelationInfo;
  mode: 'data' | 'ddl';
  visible: boolean;
  onModeChange: (mode: 'data' | 'ddl') => void;
  ensureConnected: () => Promise<boolean>;
  openInConsole: (sql: string) => void;
  onSaveFile: (fileName: string, contents: string) => void;
  notify: (message: string) => void;
};

type Loaded = { result: QueryResult; sql: string };

/**
 * Lifecycle of the visible page. While loading or after a stop, the previously loaded page stays
 * on screen (dimmed) so paging, sorting and filtering never flash an empty grid.
 */
type Page =
  | { status: 'connecting' }
  | { status: 'loading'; previous?: Loaded }
  | ({ status: 'done' } & Loaded)
  | { status: 'stopped'; previous?: Loaded }
  | { status: 'error'; error: QueryError; sql: string };

/** The rows currently worth showing for a page state. */
function shownPage(page: Page): Loaded | undefined {
  if (page.status === 'done') return page;
  if (page.status === 'loading' || page.status === 'stopped') return page.previous;
  return undefined;
}

/** Parses an ORDER BY written by header clicks (`col asc` / `"Col" desc`) back into a sort indicator. */
function parseSimpleOrder(orderBy: string): ServerSort {
  const match = /^\s*("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)\s+(asc|desc)\s*$/i.exec(orderBy);
  if (!match) return undefined;
  const column = match[1].startsWith('"') ? match[1].slice(1, -1).replace(/""/g, '"') : match[1];
  return { column, desc: match[2].toLowerCase() === 'desc' };
}

/**
 * A table or view opened from the explorer: pages of rows with WHERE / ORDER BY bars, header
 * sorting, row count on demand, export, and its DDL. Runs on the explorer connection, which gives
 * up on locks after 5 s and on any statement after 30 s, so opening a table never hangs; Stop
 * cancels a slow page sooner. Loading keeps the last page visible (dimmed) under a progress bar.
 */
export function TableView({
  connection,
  schema,
  relation,
  mode,
  visible,
  onModeChange,
  ensureConnected,
  openInConsole,
  onSaveFile,
  notify,
}: TableViewProps) {
  const [filterText, setFilterText] = useState('');
  const [orderText, setOrderText] = useState('');
  const [applied, setApplied] = useState({ filter: '', orderBy: '' });
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(500);
  const [page, setPage] = useState<Page>({ status: connection.connected ? 'loading' : 'connecting' });
  const stopRequested = useRef(false);
  const connectedRef = useRef(connection.connected);
  connectedRef.current = connection.connected;
  const [total, setTotal] = useState<
    { status: 'idle' | 'loading' } | { status: 'done'; count: number } | { status: 'error'; message: string }
  >({ status: 'idle' });
  const [ddl, setDdl] = useState<{ text?: string; error?: string }>({});
  const [selectedValue, setSelectedValue] = useState<{ name?: string; value: string | null | undefined }>();
  const [viewing, setViewing] = useState<{ name: string; type: string; value: string | null }>();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>();
  const requestId = useRef(0);
  const ensureRef = useRef(ensureConnected);
  ensureRef.current = ensureConnected;
  const qualified = `${quoteIdent(schema)}.${quoteIdent(relation.name)}`;
  const primaryKeys = useMemo(() => new Set(relation.columns.filter((c) => c.primaryKey).map((c) => c.name)), [relation]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    stopRequested.current = false;
    if (!connectedRef.current) setPage({ status: 'connecting' });
    if (!(await ensureRef.current())) {
      if (id === requestId.current) setPage({ status: 'error', error: { message: `Not connected to ${connection.name}.` }, sql: '' });
      return;
    }
    if (id !== requestId.current) return;
    setPage((current) => ({ status: 'loading', previous: shownPage(current) }));
    try {
      const response = await api.tablePage(connection.id, {
        schema,
        table: relation.name,
        filter: applied.filter,
        orderBy: applied.orderBy,
        limit: pageSize,
        offset,
      });
      if (id !== requestId.current) return;
      if (response.ok) setPage({ status: 'done', result: response.result, sql: response.sql });
      else if (stopRequested.current && response.error.code === '57014')
        setPage((current) => ({ status: 'stopped', previous: shownPage(current) }));
      else setPage({ status: 'error', error: response.error, sql: response.sql });
    } catch (error) {
      if (id !== requestId.current) return;
      const retry = error instanceof ApiError && error.notConnected && (await ensureRef.current());
      if (retry) return load();
      setPage({ status: 'error', error: { message: (error as Error).message }, sql: '' });
    }
  }, [connection.id, connection.name, schema, relation.name, applied, pageSize, offset]);

  /** Stops the page query on the server; the previous rows stay visible. */
  const stop = async () => {
    stopRequested.current = true;
    try {
      await api.cancelTableQuery(connection.id);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  useEffect(() => {
    if (mode === 'data') load();
  }, [load, mode]);

  useEffect(() => {
    if (mode !== 'ddl' || ddl.text !== undefined) return;
    ensureRef.current().then((ok) => {
      if (!ok) return;
      api.objectDdl(connection.id, schema, relation.name, 'relation').then(
        (text) => setDdl({ text }),
        (error) => setDdl({ error: (error as Error).message }),
      );
    });
  }, [mode, ddl.text, connection.id, schema, relation.name]);

  const apply = (next: { filter?: string; orderBy?: string }) => {
    setOffset(0);
    setTotal({ status: 'idle' });
    setApplied((current) => ({ filter: next.filter ?? current.filter, orderBy: next.orderBy ?? current.orderBy }));
  };

  const onBarKey = (event: KeyboardEvent<HTMLInputElement>, field: 'filter' | 'orderBy') => {
    if (event.key === 'Enter') apply({ [field]: event.currentTarget.value });
    if (event.key === 'Escape') {
      if (field === 'filter') setFilterText(applied.filter);
      else setOrderText(applied.orderBy);
    }
  };

  /** Header click: ascending → descending → unsorted, written into the ORDER BY bar. */
  const sortByHeader = (column: string) => {
    const current = parseSimpleOrder(applied.orderBy);
    const next = current?.column !== column ? `${quoteIdent(column)} asc` : current.desc ? '' : `${quoteIdent(column)} desc`;
    setOrderText(next);
    apply({ orderBy: next });
  };

  const countRows = async () => {
    setTotal({ status: 'loading' });
    try {
      setTotal({ status: 'done', count: await api.tableCount(connection.id, schema, relation.name, applied.filter) });
    } catch (error) {
      setTotal({ status: 'error', message: (error as Error).message });
    }
  };

  const shown = shownPage(page);
  const result = shown?.result;
  const busy = page.status === 'loading' || page.status === 'connecting';
  const hasNext = Boolean(result?.truncated);
  const rangeLabel =
    page.status === 'done'
      ? page.result.rows.length
        ? `${(offset + 1).toLocaleString()}–${(offset + page.result.rows.length).toLocaleString()}`
        : '0 rows'
      : busy
        ? '…'
        : result
          ? `${(offset + 1).toLocaleString()}–${(offset + result.rows.length).toLocaleString()}`
          : '—';

  const openExport = (x: number, y: number) => {
    if (!result) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => notify(`Copied ${what}`));
    setMenu({
      x,
      y,
      items: [
        { label: 'Copy page as TSV (for spreadsheets)', onSelect: () => copy(toTsv(result), `${result.rows.length} rows as TSV`) },
        { label: 'Copy page as CSV', onSelect: () => copy(toCsv(result), `${result.rows.length} rows as CSV`) },
        { label: 'Copy page as JSON', onSelect: () => copy(toJson(result), `${result.rows.length} rows as JSON`) },
        { label: 'Copy page as INSERT statements', onSelect: () => copy(toInsertSql(result, qualified), 'INSERT statements') },
        { label: 'Save page as CSV to Downloads', onSelect: () => onSaveFile(`${relation.name}-${stamp}.csv`, toCsv(result)) },
        { label: 'Save page as JSON to Downloads', onSelect: () => onSaveFile(`${relation.name}-${stamp}.json`, toJson(result)) },
      ],
    });
  };

  return (
    <div className="table-view" style={{ display: visible ? 'flex' : 'none' }} data-testid="table-view">
      <div className="toolbar">
        <div className="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'data'}
            className={mode === 'data' ? 'on' : ''}
            onClick={() => onModeChange('data')}
          >
            Data
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'ddl'}
            className={mode === 'ddl' ? 'on' : ''}
            onClick={() => onModeChange('ddl')}
            data-testid="ddl-tab"
          >
            DDL
          </button>
        </div>
        <span className="tool-sep" />
        {mode === 'data' && (
          <>
            {busy ? (
              <button
                type="button"
                className="tool danger"
                title="Stop loading"
                onClick={stop}
                disabled={page.status === 'connecting'}
                data-testid="stop-loading"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button type="button" className="tool" title="Reload page" onClick={load} data-testid="reload">
                <RefreshCw size={15} />
              </button>
            )}
            <button type="button" className="tool" title="First page" disabled={offset === 0} onClick={() => setOffset(0)}>
              <ChevronsLeft size={16} />
            </button>
            <button
              type="button"
              className="tool"
              title="Previous page"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - pageSize))}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="page-range mono" data-testid="page-range">
              {rangeLabel}
            </span>
            <button
              type="button"
              className="tool"
              title="Next page"
              disabled={!hasNext}
              onClick={() => setOffset(offset + pageSize)}
              data-testid="next-page"
            >
              <ChevronRight size={16} />
            </button>
            <select
              className="page-size"
              value={pageSize}
              onChange={(e) => {
                setOffset(0);
                setPageSize(Number(e.target.value));
              }}
              title="Rows per page"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} rows
                </option>
              ))}
            </select>
            <span className="tool-sep" />
            <button
              type="button"
              className="tool"
              title="Copy / export this page"
              disabled={!result}
              onClick={(e) => openExport(e.clientX, e.clientY)}
            >
              <Download size={15} />
            </button>
          </>
        )}
        <button
          type="button"
          className="tool"
          title="Open this query in a console"
          onClick={() => openInConsole(shown?.sql ? `${shown.sql};` : `select *\nfrom ${qualified}\nlimit 100;`)}
        >
          <SquareTerminal size={15} />
        </button>
        <span className="spacer" />
        {connection.readOnly && <span className="badge ro">READ-ONLY</span>}
        <span className="muted small">{relation.kind}</span>
      </div>
      {mode === 'data' && (
        <>
          <div className="filter-bars">
            <label className="filter-bar">
              <Filter size={14} className="muted" />
              <span className="bar-keyword">WHERE</span>
              <input
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                onKeyDown={(e) => onBarKey(e, 'filter')}
                placeholder={`<filter criteria>  e.g. ${relation.columns[0]?.name ?? 'id'} = 42 — Enter to apply`}
                spellCheck={false}
                data-testid="filter-input"
              />
              {applied.filter && (
                <button
                  type="button"
                  className="tool"
                  title="Clear filter"
                  onClick={() => {
                    setFilterText('');
                    apply({ filter: '' });
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </label>
            <label className="filter-bar">
              <ArrowDownWideNarrow size={14} className="muted" />
              <span className="bar-keyword">ORDER BY</span>
              <input
                value={orderText}
                onChange={(e) => setOrderText(e.target.value)}
                onKeyDown={(e) => onBarKey(e, 'orderBy')}
                placeholder="<ordering>  or click a column header"
                spellCheck={false}
                data-testid="order-input"
              />
              {applied.orderBy && (
                <button
                  type="button"
                  className="tool"
                  title="Clear ordering"
                  onClick={() => {
                    setOrderText('');
                    apply({ orderBy: '' });
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </label>
          </div>
          <div className="table-body">
            <ProgressBar active={busy} />
            {page.status === 'connecting' && (
              <SkeletonGrid
                columns={relation.columns.map((c) => c.name)}
                overlay={<LoadingMessage>Connecting to {connection.name}…</LoadingMessage>}
              />
            )}
            {page.status === 'loading' && !page.previous && (
              <SkeletonGrid
                columns={relation.columns.map((c) => c.name)}
                overlay={<LoadingMessage>Loading {relation.name}…</LoadingMessage>}
              />
            )}
            {page.status === 'stopped' && (
              <div className="stopped-banner" data-testid="stopped-banner">
                Stopped before the page finished loading{page.previous ? ' — showing the previous rows' : ''}.
                <button type="button" className="link" onClick={load}>
                  Reload
                </button>
              </div>
            )}
            {page.status === 'stopped' && !page.previous && <div className="grid-message">Nothing loaded.</div>}
            {page.status === 'error' && (
              <div className="query-error" data-testid="query-error">
                <strong>
                  {page.error.code ? `[${page.error.code}] ` : ''}
                  {page.error.message}
                </strong>
                {page.error.detail && <p>Detail: {page.error.detail}</p>}
                {page.error.hint && <p>Hint: {page.error.hint}</p>}
                {page.sql && <pre>{page.sql}</pre>}
                <p>
                  <button type="button" className="ghost small" onClick={load}>
                    Try again
                  </button>
                </p>
              </div>
            )}
            {result && (
              <div className={`grid-holder${page.status === 'loading' ? ' dimmed' : ''}`} aria-busy={page.status === 'loading'}>
                <ResultsGrid
                  result={result}
                  firstRowNumber={offset + 1}
                  primaryKeys={primaryKeys}
                  serverSort={{ current: parseSimpleOrder(applied.orderBy), onHeaderClick: sortByHeader }}
                  onSelectValue={(value, name) => setSelectedValue({ value, name })}
                  onOpenValue={(value, name, type) => setViewing({ value, name, type })}
                />
              </div>
            )}
            {result && (
              <div className="row-pill" data-testid="row-pill">
                {page.status === 'loading' ? (
                  <span className="pill-loading">
                    <Spinner size={11} /> Loading <ElapsedLabel active />
                  </span>
                ) : (
                  <span>
                    {result.rows.length.toLocaleString()} row{result.rows.length === 1 ? '' : 's'}
                    {hasNext ? '+' : ''}
                  </span>
                )}
                <span className="pill-sep" />
                {total.status === 'idle' && (
                  <button type="button" className="link-button" onClick={countRows} title="Run count(*) with the current filter">
                    count all
                  </button>
                )}
                {total.status === 'loading' && (
                  <span className="pill-loading">
                    <Spinner size={11} /> counting <ElapsedLabel active />
                  </span>
                )}
                {total.status === 'done' && <span data-testid="total-count">of {total.count.toLocaleString()}</span>}
                {total.status === 'error' && (
                  <span className="error-text" title={total.message}>
                    count failed
                  </span>
                )}
                <span className="pill-sep" />
                <span className="muted">{result.durationMs} ms</span>
              </div>
            )}
          </div>
          {selectedValue && selectedValue.value !== undefined && (
            <div className="value-bar mono">
              <span className="muted">{selectedValue.name}:</span>{' '}
              {selectedValue.value === null ? <em className="muted">&lt;null&gt;</em> : selectedValue.value.slice(0, 500)}
            </div>
          )}
        </>
      )}
      {mode === 'ddl' && <DdlViewer ddl={ddl.text} error={ddl.error} />}
      {viewing && (
        <Modal
          title={`${viewing.name} (${viewing.type})`}
          onClose={() => setViewing(undefined)}
          wide
          footer={
            <>
              <span className="spacer" />
              <button type="button" className="ghost" onClick={() => navigator.clipboard.writeText(viewing.value ?? '')}>
                Copy
              </button>
              <button type="button" className="primary" onClick={() => setViewing(undefined)}>
                Close
              </button>
            </>
          }
        >
          <pre className="value-viewer">
            {viewing.value === null
              ? '<null>'
              : /^jsonb?$/.test(viewing.type)
                ? (() => {
                    try {
                      return JSON.stringify(JSON.parse(viewing.value!), null, 2);
                    } catch {
                      return viewing.value;
                    }
                  })()
                : viewing.value}
          </pre>
        </Modal>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(undefined)} />}
    </div>
  );
}
