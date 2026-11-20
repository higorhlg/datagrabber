import { ChevronRight } from 'lucide-react';
import type { ConnectionSummary } from '../lib/types.ts';

type StatusBarProps = { breadcrumb: string[]; connection: ConnectionSummary | undefined; serverVersion: string | undefined };

/** Bottom bar: where you are (breadcrumb) and the active connection's state. */
export function StatusBar({ breadcrumb, connection, serverVersion }: StatusBarProps) {
  return (
    <footer className="status-bar">
      <nav className="breadcrumb" aria-label="Location" data-testid="breadcrumb">
        <span>Database</span>
        {breadcrumb.map((part, i) => (
          <span key={`${i}-${part}`} className="crumb">
            <ChevronRight size={12} />
            {part}
          </span>
        ))}
      </nav>
      <span className="spacer" />
      {connection && (
        <span className="status-right">
          {connection.readOnly && <span className="badge ro">READ-ONLY</span>}
          <span className={`status-dot${connection.connected ? ' on' : ''}`} />
          {connection.connected ? `PostgreSQL ${serverVersion ?? ''}` : 'disconnected'}
        </span>
      )}
    </footer>
  );
}
