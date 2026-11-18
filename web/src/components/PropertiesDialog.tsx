import type { ConnectionSummary, RelationInfo } from '../../../shared/types.ts';
import { Modal } from './Modal.tsx';

type PropertiesDialogProps = {
  connection: ConnectionSummary;
  schema: string;
  relation: RelationInfo;
  onOpen: () => void;
  onShowDdl: () => void;
  onClose: () => void;
};

const KIND_EXPLANATION: Record<RelationInfo['kind'], string> = {
  table: 'Stores rows.',
  'partitioned table': 'Stores rows split across partitions.',
  'foreign table': 'Rows live in another server (foreign data wrapper).',
  view: 'A saved query: no rows of its own, computed from other tables each time it is read.',
  'materialized view': 'A saved query whose result is stored and refreshed on demand.',
};

/** Read-only overview of a table or view: what it is, its columns, keys, foreign keys and indexes. */
export function PropertiesDialog({ connection, schema, relation: r, onOpen, onShowDdl, onClose }: PropertiesDialogProps) {
  return (
    <Modal
      wide
      title={`${schema}.${r.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small">{connection.name}</span>
          <span className="spacer" />
          <button className="ghost" onClick={onShowDdl}>Show DDL</button>
          <button className="primary" onClick={onOpen}>Open {r.kind.includes('view') ? 'view' : 'table'}</button>
        </>
      }
    >
      <dl className="props-summary" data-testid="properties">
        <dt>Type</dt>
        <dd><strong className="kind-label">{r.kind}</strong> <span className="muted">— {KIND_EXPLANATION[r.kind]}</span></dd>
        <dt>Rows</dt>
        <dd>{r.estimatedRows === null ? <span className="muted">no estimate (not analyzed{r.kind === 'view' ? ', views have no stored rows' : ''})</span> : `~${r.estimatedRows.toLocaleString()} (planner estimate)`}</dd>
      </dl>
      <h3 className="props-heading">Columns <span className="muted">{r.columns.length}</span></h3>
      <table className="props-table">
        <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead>
        <tbody>
          {r.columns.map((c) => (
            <tr key={c.name}>
              <td className="mono">{c.primaryKey && <span className="badge pk">PK</span>}{c.name}</td>
              <td className="mono">{c.type}</td>
              <td>{c.notNull ? 'no' : 'yes'}</td>
              <td className="mono muted">{c.default ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.foreignKeys.length > 0 && (
        <>
          <h3 className="props-heading">Foreign keys <span className="muted">{r.foreignKeys.length}</span></h3>
          <ul className="props-list">{r.foreignKeys.map((fk) => <li key={fk.name}><span className="mono">{fk.name}</span> <span className="muted mono">{fk.definition}</span></li>)}</ul>
        </>
      )}
      {r.indexes.length > 0 && (
        <>
          <h3 className="props-heading">Keys and indexes <span className="muted">{r.indexes.length}</span></h3>
          <ul className="props-list">{r.indexes.map((i) => <li key={i.name}><span className="mono">{i.name}</span> {i.primary ? <span className="badge pk">primary</span> : i.unique ? <span className="badge">unique</span> : null} <span className="muted mono">{i.definition}</span></li>)}</ul>
        </>
      )}
    </Modal>
  );
}
