import { useEffect, useRef, useState } from 'react';
import type { ConnectionSummary } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { DdlViewer } from './DdlViewer.tsx';

type DdlTabProps = {
  connection: ConnectionSummary;
  schema: string;
  name: string;
  kind: 'sequence' | 'routine';
  args?: string;
  visible: boolean;
  ensureConnected: () => Promise<boolean>;
};

/** A tab showing the DDL of a sequence or routine. */
export function DdlTab({ connection, schema, name, kind, args, visible, ensureConnected }: DdlTabProps) {
  const [ddl, setDdl] = useState<{ text?: string; error?: string }>({});
  const ensureRef = useRef(ensureConnected);
  ensureRef.current = ensureConnected;

  useEffect(() => {
    ensureRef.current().then((ok) => {
      if (!ok) return;
      api.objectDdl(connection.id, schema, name, kind, args).then((text) => setDdl({ text }), (error) => setDdl({ error: (error as Error).message }));
    });
  }, [connection.id, schema, name, kind, args]);

  return (
    <div className="table-view" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="toolbar">
        <span className="muted small">{kind} · {schema}.{name}{args !== undefined ? `(${args})` : ''}</span>
        <span className="spacer" />
        <button className="ghost small" disabled={!ddl.text} onClick={() => navigator.clipboard.writeText(ddl.text ?? '')}>Copy</button>
      </div>
      <DdlViewer ddl={ddl.text} error={ddl.error} />
    </div>
  );
}
