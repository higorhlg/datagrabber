import { ArrowDown, ArrowUp, Columns2, KeyRound } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { QueryResult } from '../lib/types.ts';

const ROW_HEIGHT = 26;
const OVERSCAN = 12;
/** Cell padding and border plus the header's column icon, sort arrow and gaps, added to each column's text width. */
const CELL_PADDING_PX = 48;
const NUMERIC_TYPES = /^(int[248]|float[48]|numeric|oid|money)/;

type Cell = { row: number; col: number };
type Sort = { col: number; desc: boolean };

/** Sorting done by the server (table tabs): the grid shows the indicator and reports clicks. */
export type ServerSort = { column: string; desc: boolean } | undefined;

type ResultsGridProps = {
  result: QueryResult;
  filter?: string;
  onSelectValue: (value: string | null | undefined, columnName?: string) => void;
  onOpenValue: (value: string | null, columnName: string, type: string) => void;
  /** When set, header clicks call onHeaderClick instead of sorting the loaded rows. */
  serverSort?: { current: ServerSort; onHeaderClick: (column: string) => void };
  /** Columns shown with a key icon. */
  primaryKeys?: Set<string>;
  /** Number shown for the first row (1-based), for paged results. */
  firstRowNumber?: number;
};

/**
 * Estimates column widths in `ch` from the header and a sample of values, so columns don't
 * jump while scrolling a virtualized list.
 */
function columnWidths(result: QueryResult): number[] {
  const sample = result.rows.slice(0, 300);
  return result.columns.map((column, i) => {
    const longest = sample.reduce((max, row) => Math.max(max, Math.min((row[i] ?? 'NULL').length, 60)), 0);
    return Math.max(column.name.length + column.type.length + 2, longest + 1, 4);
  });
}

/**
 * Compares two cell values, numerically for numeric columns. NULLs sort last.
 * @param numeric - whether the column type is numeric
 */
function compareCells(a: string | null, b: string | null, numeric: boolean): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return numeric ? Number(a) - Number(b) : a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Read-only results grid: virtualized rows, sortable headers (locally, or by the server for table
 * tabs), cell selection with arrow keys, ⌘C copy, Enter/double-click to open a value.
 */
export function ResultsGrid({
  result,
  filter = '',
  onSelectValue,
  onOpenValue,
  serverSort,
  primaryKeys,
  firstRowNumber = 1,
}: ResultsGridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [sort, setSort] = useState<Sort>();
  const [selected, setSelected] = useState<Cell>();
  const widths = useMemo(() => columnWidths(result), [result]);
  const template = `56px ${widths.map((w) => `calc(${w}ch + ${CELL_PADDING_PX}px)`).join(' ')}`;

  const sortsOnServer = Boolean(serverSort);
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let indexed = result.rows.map((row, index) => ({ row, index }));
    if (needle) indexed = indexed.filter(({ row }) => row.some((v) => v?.toLowerCase().includes(needle)));
    if (sort && !sortsOnServer) {
      const numeric = NUMERIC_TYPES.test(result.columns[sort.col]?.type ?? '');
      indexed = [...indexed].sort((a, b) => compareCells(a.row[sort.col], b.row[sort.col], numeric) * (sort.desc ? -1 : 1));
    }
    return indexed;
  }, [result, filter, sort, sortsOnServer]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new result resets sorting, selection and scroll
  useEffect(() => {
    setSort(undefined);
    setSelected(undefined);
    scroller.current?.scrollTo({ top: 0 });
  }, [result]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  const select = (cell: Cell) => {
    setSelected(cell);
    onSelectValue(rows[cell.row]?.row[cell.col], result.columns[cell.col]?.name);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!selected) return;
    const move = (row: number, col: number) => {
      event.preventDefault();
      const next = { row: Math.max(0, Math.min(rows.length - 1, row)), col: Math.max(0, Math.min(result.columns.length - 1, col)) };
      select(next);
      const top = next.row * ROW_HEIGHT;
      const element = scroller.current;
      if (element && (top < element.scrollTop + ROW_HEIGHT || top > element.scrollTop + element.clientHeight - 2 * ROW_HEIGHT)) {
        element.scrollTop = top - element.clientHeight / 2;
      }
    };
    if (event.key === 'ArrowDown') move(selected.row + 1, selected.col);
    else if (event.key === 'ArrowUp') move(selected.row - 1, selected.col);
    else if (event.key === 'ArrowRight' || event.key === 'Tab') move(selected.row, selected.col + 1);
    else if (event.key === 'ArrowLeft') move(selected.row, selected.col - 1);
    else if ((event.metaKey || event.ctrlKey) && event.key === 'c') {
      event.preventDefault();
      navigator.clipboard.writeText(rows[selected.row]?.row[selected.col] ?? '');
    } else if (event.key === 'Enter') {
      const column = result.columns[selected.col];
      onOpenValue(rows[selected.row]?.row[selected.col] ?? null, column.name, column.type);
    }
  };

  const toggleSort = (col: number) => {
    if (serverSort) serverSort.onHeaderClick(result.columns[col].name);
    else setSort((s) => (s?.col !== col ? { col, desc: false } : s.desc ? undefined : { col, desc: true }));
  };
  const sortOf = (col: number): 'asc' | 'desc' | undefined => {
    if (serverSort) return serverSort.current?.column === result.columns[col].name ? (serverSort.current.desc ? 'desc' : 'asc') : undefined;
    return sort?.col === col ? (sort.desc ? 'desc' : 'asc') : undefined;
  };

  if (result.columns.length === 0) {
    return (
      <div className="grid-message">
        {result.command} completed{result.rowCount !== null ? ` — ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} affected` : ''}.
      </div>
    );
  }

  return (
    <div
      className="grid"
      ref={scroller}
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={result.columns.length}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      data-testid="results-grid"
    >
      <div className="grid-header" style={{ gridTemplateColumns: template }}>
        <div className="grid-corner">#</div>
        {result.columns.map((column, col) => (
          <button
            type="button"
            key={col}
            className="grid-head-cell"
            onClick={() => toggleSort(col)}
            title={`${column.name} (${column.type}) — click to sort`}
          >
            {primaryKeys?.has(column.name) ? <KeyRound size={13} className="col-icon pk" /> : <Columns2 size={13} className="col-icon" />}
            <span className="col-name">{column.name}</span>
            <span className="col-type">{column.type}</span>
            {sortOf(col) === 'asc' && <ArrowUp size={12} className="sort-mark" />}
            {sortOf(col) === 'desc' && <ArrowDown size={12} className="sort-mark" />}
          </button>
        ))}
      </div>
      <div className="grid-body" style={{ height: rows.length * ROW_HEIGHT }}>
        {rows.slice(first, last).map(({ row, index }, offset) => {
          const visual = first + offset;
          return (
            <div key={visual} className="grid-row" style={{ gridTemplateColumns: template, top: visual * ROW_HEIGHT }}>
              <div className="grid-rownum">{index + firstRowNumber}</div>
              {row.map((value, col) => (
                <div
                  key={col}
                  className={`grid-cell${value === null ? ' null' : ''}${selected?.row === visual && selected.col === col ? ' selected' : ''}${NUMERIC_TYPES.test(result.columns[col].type) ? ' numeric' : ''}`}
                  onMouseDown={() => select({ row: visual, col })}
                  onDoubleClick={() => onOpenValue(value, result.columns[col].name, result.columns[col].type)}
                >
                  {value === null ? '<null>' : value.length > 300 ? `${value.slice(0, 300)}…` : value}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {rows.length === 0 && <div className="grid-message">{filter ? 'No rows match the filter.' : 'No rows.'}</div>}
    </div>
  );
}
