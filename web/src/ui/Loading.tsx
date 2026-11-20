import { type ReactNode, useEffect, useState } from 'react';

/** Small rotating ring. */
export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

/** Thin indeterminate bar pinned to the top of a pane while something loads. */
export function ProgressBar({ active }: { active: boolean }) {
  return <div className={`progress-bar${active ? ' active' : ''}`} aria-hidden={!active} />;
}

/**
 * Milliseconds since `active` last became true (0 while inactive), updated ten times a second.
 * @param active - whether the timer runs
 */
export function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!active) return;
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed(performance.now() - started), 100);
    return () => window.clearInterval(timer);
  }, [active]);
  return elapsed;
}

/** "1.4s" once a wait passes half a second; nothing before, so quick loads don't flash a number. */
export function ElapsedLabel({ active }: { active: boolean }) {
  const elapsed = useElapsed(active);
  if (!active || elapsed < 500) return null;
  return <span className="elapsed mono">{(elapsed / 1000).toFixed(1)}s</span>;
}

/** Centered message with a spinner, for waits that replace a pane's content. */
export function LoadingMessage({ children, active = true }: { children: ReactNode; active?: boolean }) {
  return (
    <div className="loading-message">
      <Spinner size={14} />
      <span>{children}</span>
      <ElapsedLabel active={active} />
    </div>
  );
}

const SKELETON_WIDTHS = [72, 54, 88, 63, 47, 80, 58, 69, 51, 76, 60, 84];

/**
 * Placeholder grid: real column headers (known from the schema) over shimmering rows, so a table
 * tab has its final shape before the first page arrives.
 */
export function SkeletonGrid({ columns, rows = 14, overlay }: { columns: string[]; rows?: number; overlay?: ReactNode }) {
  const shown = columns.length ? columns : ['', '', '', ''];
  const template = `56px ${shown.map((c) => `calc(${Math.max(c.length + 6, 12)}ch + 48px)`).join(' ')}`;
  return (
    <div className="grid skeleton-grid" aria-busy="true" data-testid="skeleton-grid">
      <div className="grid-header" style={{ gridTemplateColumns: template }}>
        <div className="grid-corner">#</div>
        {shown.map((name, i) => (
          <div key={i} className="grid-head-cell static">
            <span className="col-name">{name || <span className="shimmer" style={{ width: 60 }} />}</span>
          </div>
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="skeleton-row" style={{ gridTemplateColumns: template }}>
          <div className="grid-rownum" />
          {shown.map((_, c) => (
            <div key={c} className="grid-cell">
              <span className="shimmer" style={{ width: `${SKELETON_WIDTHS[(r * 3 + c) % SKELETON_WIDTHS.length]}%` }} />
            </div>
          ))}
        </div>
      ))}
      {overlay && <div className="skeleton-overlay">{overlay}</div>}
    </div>
  );
}

/** Placeholder tree rows shown under a connection while its schema loads. */
export function SkeletonTree({ depth, label }: { depth: number; label: string }) {
  return (
    <div className="skeleton-tree" aria-busy="true">
      <div className="tree-row loading-row" style={{ paddingLeft: 8 + depth * 16 }}>
        <span className="chevron" />
        <Spinner />
        <span className="node-label muted">{label}</span>
        <ElapsedLabel active />
      </div>
      {[64, 48, 72, 56].map((width, i) => (
        <div key={i} className="tree-row" style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
          <span className="chevron" />
          <span className="shimmer" style={{ width: 14, height: 14 }} />
          <span className="shimmer" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}
