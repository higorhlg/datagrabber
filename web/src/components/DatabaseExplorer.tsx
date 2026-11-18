import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  Database,
  Eye,
  FileCode2,
  Folder,
  FolderOpen,
  FunctionSquare,
  KeyRound,
  Layers,
  Link2,
  ListOrdered,
  Plus,
  RefreshCw,
  Rows3,
  Server,
  SquareTerminal,
  Table2,
  Unplug,
  Download,
  ListTree,
  Info,
  KeySquare,
} from 'lucide-react';
import type { ConnectionSummary, DatabaseSchema, RelationInfo, RoutineInfo, SchemaInfo } from '../../../shared/types.ts';
import { quoteIdent } from '../completion.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';

export type SchemaState = { status: 'loading' } | { status: 'ready'; schema: DatabaseSchema } | { status: 'error'; message: string };

/** An object picked in the explorer, with the breadcrumb that leads to it. */
export type ExplorerSelection = { key: string; connectionId: string; path: string[] };

export type ExplorerActions = {
  openConsole: (connection: ConnectionSummary) => void;
  openTable: (connection: ConnectionSummary, schema: string, relation: RelationInfo, mode?: 'data' | 'ddl') => void;
  openDdl: (connection: ConnectionSummary, schema: string, name: string, kind: 'sequence' | 'routine', args?: string) => void;
  showProperties: (connection: ConnectionSummary, schema: string, relation: RelationInfo) => void;
  insertIntoConsole: (connection: ConnectionSummary, sql: string) => void;
  connect: (connection: ConnectionSummary) => void;
  disconnect: (connection: ConnectionSummary) => void;
  refreshSchema: (connection: ConnectionSummary) => void;
  edit: (connection: ConnectionSummary) => void;
  forgetPassword: (connection: ConnectionSummary) => void;
  remove: (connection: ConnectionSummary) => void;
  newConnection: () => void;
  importDatagrip: () => void;
  /** Copies DataGrip's saved passwords; with a connection, only that one. */
  copyDatagripPasswords: (connection?: ConnectionSummary) => void;
  notify: (message: string) => void;
};

type DatabaseExplorerProps = {
  connections: ConnectionSummary[];
  schemas: Record<string, SchemaState | undefined>;
  selection: ExplorerSelection | undefined;
  onSelect: (selection: ExplorerSelection) => void;
  actions: ExplorerActions;
};

type Menu = { x: number; y: number; items: MenuItem[] };

const SHOW_ALL_KEY = 'datagrabber.explorer.showAllKinds';

/** Whether views, sequences and routines are listed, remembered between launches. */
function useShowAllKinds(): [boolean, (value: boolean) => void] {
  const [showAll, setShowAll] = useState(() => {
    try {
      return localStorage.getItem(SHOW_ALL_KEY) === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SHOW_ALL_KEY, String(showAll));
    } catch {
      // Preference is a convenience; ignore storage failures.
    }
  }, [showAll]);
  return [showAll, setShowAll];
}

/** Formats a planner row estimate compactly (12.3k, 4.1M). */
function formatEstimate(rows: number | null): string {
  if (rows === null) return '';
  if (rows >= 1_000_000) return `${(rows / 1_000_000).toFixed(1)}M`;
  if (rows >= 1_000) return `${(rows / 1_000).toFixed(1)}k`;
  return String(rows);
}

/** Schemas to expand on first connect: the non-empty ones, when there are only a few. */
function defaultOpenSchemas(schema: DatabaseSchema): Set<string> {
  const nonEmpty = schema.schemas.filter((s) => s.relations.length > 0);
  return new Set(nonEmpty.length <= 3 ? nonEmpty.map((s) => s.name) : schema.searchPath);
}

type RowProps = {
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  extra?: ReactNode;
  expandable?: boolean;
  open?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  title?: string;
  className?: string;
};

/** One tree line: indent, chevron, icon, label and trailing muted info. */
function Row({ depth, icon, label, extra, expandable, open, selected, onToggle, onClick, onDoubleClick, onContextMenu, title, className }: RowProps) {
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}${className ? ` ${className}` : ''}`}
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={onClick ?? onToggle}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={title}
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      aria-selected={selected}
    >
      <span
        className="chevron"
        onClick={(e) => {
          if (!expandable) return;
          e.stopPropagation();
          onToggle?.();
        }}
      >
        {expandable ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
      </span>
      <span className="node-icon">{icon}</span>
      <span className="node-label">{label}</span>
      {extra !== undefined && extra !== '' && <span className="node-extra">{extra}</span>}
    </div>
  );
}

/** DataGrip-style explorer: connections → database → schemas → object folders → objects → details. */
export function DatabaseExplorer({ connections, schemas, selection, onSelect, actions }: DatabaseExplorerProps) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<Menu>();
  const [showAllKinds, setShowAllKinds] = useShowAllKinds();
  const needle = filter.trim().toLowerCase();

  const isOpen = (key: string, fallback: boolean) => (needle ? true : (expanded[key] ?? fallback));
  const toggle = (key: string, fallback: boolean) => setExpanded((e) => ({ ...e, [key]: !(e[key] ?? fallback) }));
  const selectedConnection = connections.find((c) => c.id === selection?.connectionId);

  const showMenu = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const connectionMenu = (c: ConnectionSummary): MenuItem[] => [
    { label: 'Open query console', onSelect: () => actions.openConsole(c) },
    c.connected ? { label: 'Refresh schema', onSelect: () => actions.refreshSchema(c) } : { label: 'Connect', onSelect: () => actions.connect(c) },
    { label: 'Edit connection…', onSelect: () => actions.edit(c) },
    { label: 'Disconnect', onSelect: () => actions.disconnect(c), disabled: !c.connected },
    ...(c.datagripUuid ? [{ label: 'Copy password from DataGrip', onSelect: () => actions.copyDatagripPasswords(c) }] : []),
    { label: 'Forget saved password', onSelect: () => actions.forgetPassword(c), disabled: !c.passwordSaved },
    { label: 'Delete connection…', onSelect: () => actions.remove(c), danger: true },
  ];

  const relationMenu = (c: ConnectionSummary, schema: string, r: RelationInfo): MenuItem[] => {
    const name = `${quoteIdent(schema)}.${quoteIdent(r.name)}`;
    return [
      { label: r.kind.includes('view') ? 'Open view' : 'Open table', onSelect: () => actions.openTable(c, schema, r) },
      { label: 'Properties…', onSelect: () => actions.showProperties(c, schema, r) },
      { label: 'Show DDL', onSelect: () => actions.openTable(c, schema, r, 'ddl') },
      { label: 'Write SELECT in console', onSelect: () => actions.insertIntoConsole(c, `select *\nfrom ${name}\nlimit 100;`) },
      { label: 'Copy qualified name', onSelect: () => navigator.clipboard.writeText(name).then(() => actions.notify(`Copied ${name}`)) },
    ];
  };

  const toolbarConnection = selectedConnection;
  const selectedRelation = useMemo(() => {
    if (!selection || !selectedConnection) return undefined;
    const match = /^[^/]+\/db\/([^/]+)\/rel\/(.+)$/.exec(selection.key);
    if (!match) return undefined;
    const state = schemas[selectedConnection.id];
    if (state?.status !== 'ready') return undefined;
    const relation = state.schema.schemas.find((s) => s.name === match[1])?.relations.find((r) => r.name === match[2]);
    return relation ? { schema: match[1], relation } : undefined;
  }, [selection, selectedConnection, schemas]);

  return (
    <aside className="explorer island">
      <header className="island-head">
        <span className="island-title">Database Explorer</span>
      </header>
      <div className="explorer-toolbar" role="toolbar">
        <button className="tool" title="New connection" onClick={actions.newConnection}><Plus size={16} /></button>
        <button className="tool" title="Import from DataGrip" onClick={actions.importDatagrip}><Download size={16} /></button>
        <button className="tool" title="Copy passwords saved in DataGrip" onClick={() => actions.copyDatagripPasswords()} data-testid="copy-passwords"><KeySquare size={16} /></button>
        <span className="tool-sep" />
        <button className="tool" title="Refresh schema" disabled={!toolbarConnection?.connected} onClick={() => toolbarConnection && actions.refreshSchema(toolbarConnection)}><RefreshCw size={16} /></button>
        <button className="tool" title="Disconnect" disabled={!toolbarConnection?.connected} onClick={() => toolbarConnection && actions.disconnect(toolbarConnection)}><Unplug size={16} /></button>
        <span className="tool-sep" />
        <button className="tool" title="Open query console" disabled={!toolbarConnection} onClick={() => toolbarConnection && actions.openConsole(toolbarConnection)}><SquareTerminal size={16} /></button>
        <button className="tool" title="Open table" disabled={!selectedRelation} onClick={() => toolbarConnection && selectedRelation && actions.openTable(toolbarConnection, selectedRelation.schema, selectedRelation.relation)}><Table2 size={16} /></button>
        <button className="tool text" title="Show DDL" disabled={!selectedRelation} onClick={() => toolbarConnection && selectedRelation && actions.openTable(toolbarConnection, selectedRelation.schema, selectedRelation.relation, 'ddl')}>DDL</button>
        <button className="tool" title="Properties" disabled={!selectedRelation} onClick={() => toolbarConnection && selectedRelation && actions.showProperties(toolbarConnection, selectedRelation.schema, selectedRelation.relation)}><Info size={16} /></button>
        <span className="tool-sep" />
        <button className={`tool${showAllKinds ? ' pressed' : ''}`} title={showAllKinds ? 'Showing views, sequences and routines — click to show tables only' : 'Showing tables only — click to also show views, sequences and routines'} aria-pressed={showAllKinds} onClick={() => setShowAllKinds(!showAllKinds)} data-testid="toggle-all-kinds"><Eye size={16} /></button>
        <button className="tool" title="Collapse all" onClick={() => setExpanded(Object.fromEntries(connections.map((c) => [c.id, false])))}><ListTree size={16} /></button>
      </div>
      <input className="explorer-filter" placeholder="Filter objects…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter objects" />
      <div className="tree" role="tree">
        {connections.length === 0 && (
          <div className="tree-empty">
            No connections yet.<br />
            <button className="link" onClick={actions.importDatagrip}>Import from DataGrip</button> or <button className="link" onClick={actions.newConnection}>add one</button>.
          </div>
        )}
        {connections.map((c) => {
          const state = schemas[c.id];
          const connKey = c.id;
          const connOpen = c.connected && isOpen(connKey, true);
          const connectionPath = [c.name];
          return (
            <div key={c.id} style={{ ['--conn-color' as string]: c.color }}>
              <Row
                depth={0}
                className="connection-row"
                expandable
                open={connOpen}
                selected={selection?.key === connKey}
                icon={<span className="conn-icon"><Server size={15} />{c.connected && <span className="conn-live" />}</span>}
                label={c.name}
                extra={c.readOnly ? <span className="badge ro">RO</span> : undefined}
                title={`${c.user}@${c.host}:${c.port}/${c.database}${c.readOnly ? ' — read-only' : ''}\nDouble-click to open a console`}
                onToggle={() => (c.connected ? toggle(connKey, true) : actions.connect(c))}
                onClick={() => {
                  onSelect({ key: connKey, connectionId: c.id, path: connectionPath });
                  if (!c.connected) actions.connect(c);
                }}
                onDoubleClick={() => actions.openConsole(c)}
                onContextMenu={(e) => showMenu(e, connectionMenu(c))}
              />
              {connOpen && state?.status === 'loading' && <div className="tree-note" style={{ paddingLeft: 40 }}>Loading…</div>}
              {connOpen && state?.status === 'error' && <div className="tree-note error" style={{ paddingLeft: 40 }}>{state.message}</div>}
              {connOpen && state?.status === 'ready' && (
                <DatabaseNode
                  connection={c}
                  schema={state.schema}
                  needle={needle}
                  isOpen={isOpen}
                  toggle={toggle}
                  selection={selection}
                  onSelect={onSelect}
                  actions={actions}
                  relationMenu={(e, schemaName, r) => showMenu(e, relationMenu(c, schemaName, r))}
                  objectMenu={(e, items) => showMenu(e, items)}
                  showAllKinds={showAllKinds || Boolean(needle)}
                  onShowAllKinds={() => setShowAllKinds(true)}
                />
              )}
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(undefined)} />}
    </aside>
  );
}

type DatabaseNodeProps = {
  connection: ConnectionSummary;
  schema: DatabaseSchema;
  needle: string;
  isOpen: (key: string, fallback: boolean) => boolean;
  toggle: (key: string, fallback: boolean) => void;
  selection: ExplorerSelection | undefined;
  onSelect: (selection: ExplorerSelection) => void;
  actions: ExplorerActions;
  relationMenu: (event: MouseEvent, schema: string, relation: RelationInfo) => void;
  objectMenu: (event: MouseEvent, items: MenuItem[]) => void;
  /** When false only tables are listed, with a line offering to reveal the rest. */
  showAllKinds: boolean;
  onShowAllKinds: () => void;
};

/** The database node and everything below it. */
function DatabaseNode({ connection: c, schema, needle, isOpen, toggle, selection, onSelect, actions, relationMenu, objectMenu, showAllKinds, onShowAllKinds }: DatabaseNodeProps) {
  const dbKey = `${c.id}/db`;
  const openByDefault = useMemo(() => defaultOpenSchemas(schema), [schema]);
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const visible = schema.schemas
    .map((s) => ({
      ...s,
      relations: s.relations.filter((r) => matches(r.name)),
      sequences: s.sequences.filter(matches),
      routines: s.routines.filter((r) => matches(r.name)),
    }))
    .filter((s) => !needle || s.relations.length + s.sequences.length + s.routines.length > 0);
  const dbOpen = isOpen(dbKey, true);
  const path = [c.name, c.database];

  return (
    <>
      <Row
        depth={1}
        expandable
        open={dbOpen}
        selected={selection?.key === dbKey}
        icon={<Database size={15} className="ic-db" />}
        label={c.database}
        extra={`${schema.schemas.length} schema${schema.schemas.length === 1 ? '' : 's'}`}
        onToggle={() => toggle(dbKey, true)}
        onClick={() => {
          onSelect({ key: dbKey, connectionId: c.id, path });
          toggle(dbKey, true);
        }}
      />
      {dbOpen &&
        visible.map((s) => (
          <SchemaNode
            key={s.name}
            connection={c}
            schemaInfo={s}
            parentKey={dbKey}
            path={[...path, s.name]}
            defaultOpen={openByDefault.has(s.name)}
            isOpen={isOpen}
            toggle={toggle}
            selection={selection}
            onSelect={onSelect}
            actions={actions}
            relationMenu={relationMenu}
            objectMenu={objectMenu}
            showAllKinds={showAllKinds}
            onShowAllKinds={onShowAllKinds}
          />
        ))}
    </>
  );
}

type SchemaNodeProps = Omit<DatabaseNodeProps, 'schema' | 'needle'> & {
  schemaInfo: SchemaInfo;
  parentKey: string;
  path: string[];
  defaultOpen: boolean;
};

/** Describes what the tables-only view hides, e.g. "17 views · 15 routines". */
function hiddenSummary(views: number, matviews: number, sequences: number, routines: number): string {
  const part = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
  return [part(views, 'view'), part(matviews, 'materialized view'), part(sequences, 'sequence'), part(routines, 'routine')].filter(Boolean).join(' · ');
}

/**
 * A schema with folders for tables, views, materialized views, sequences and routines. In
 * tables-only mode the other folders collapse into a single line that reveals them.
 */
function SchemaNode({ connection: c, schemaInfo: s, parentKey, path, defaultOpen, isOpen, toggle, selection, onSelect, actions, relationMenu, objectMenu, showAllKinds, onShowAllKinds }: SchemaNodeProps) {
  const schemaKey = `${parentKey}/${s.name}`;
  const open = isOpen(schemaKey, defaultOpen);
  const tables = s.relations.filter((r) => r.kind === 'table' || r.kind === 'partitioned table' || r.kind === 'foreign table');
  const views = s.relations.filter((r) => r.kind === 'view');
  const matviews = s.relations.filter((r) => r.kind === 'materialized view');
  const total = showAllKinds ? s.relations.length + s.sequences.length + s.routines.length : tables.length;
  const hidden = showAllKinds ? '' : hiddenSummary(views.length, matviews.length, s.sequences.length, s.routines.length);

  const folder = (name: string, count: number, fallbackOpen: boolean, children: () => ReactNode) => {
    if (count === 0) return null;
    const key = `${schemaKey}/~${name}`;
    const folderOpen = isOpen(key, fallbackOpen);
    return (
      <div key={name}>
        <Row
          depth={3}
          expandable
          open={folderOpen}
          selected={selection?.key === key}
          icon={folderOpen ? <FolderOpen size={15} className="ic-folder" /> : <Folder size={15} className="ic-folder" />}
          label={name}
          extra={count}
          onToggle={() => toggle(key, fallbackOpen)}
          onClick={() => {
            onSelect({ key, connectionId: c.id, path: [...path, name] });
            toggle(key, fallbackOpen);
          }}
        />
        {folderOpen && children()}
      </div>
    );
  };

  const relationRows = (list: RelationInfo[], folderName: string) =>
    list.map((r) => (
      <RelationNode
        key={r.name}
        connection={c}
        schema={s.name}
        relation={r}
        relKey={`${parentKey}/${s.name}/rel/${r.name}`}
        path={[...path, folderName, r.name]}
        isOpen={isOpen}
        toggle={toggle}
        selection={selection}
        onSelect={onSelect}
        actions={actions}
        onContextMenu={(e) => relationMenu(e, s.name, r)}
      />
    ));

  const ddlMenu = (name: string, kind: 'sequence' | 'routine', args?: string): MenuItem[] => [
    { label: 'Show DDL', onSelect: () => actions.openDdl(c, s.name, name, kind, args) },
    { label: 'Copy qualified name', onSelect: () => navigator.clipboard.writeText(`${quoteIdent(s.name)}.${quoteIdent(name)}`) },
  ];

  return (
    <>
      <Row
        depth={2}
        expandable
        open={open}
        selected={selection?.key === schemaKey}
        icon={<Layers size={15} className="ic-schema" />}
        label={s.name}
        extra={total || undefined}
        onToggle={() => toggle(schemaKey, defaultOpen)}
        onClick={() => {
          onSelect({ key: schemaKey, connectionId: c.id, path });
          toggle(schemaKey, defaultOpen);
        }}
      />
      {open && (
        <>
          {folder('tables', tables.length, true, () => relationRows(tables, 'tables'))}
          {hidden && (
            <div className="tree-row hidden-kinds" style={{ paddingLeft: 8 + 3 * 16 }} onClick={onShowAllKinds} title="Show views, sequences and routines (👁 in the toolbar toggles this)">
              <span className="chevron" />
              <span className="node-label muted">{hidden} hidden — <span className="link-text">show</span></span>
            </div>
          )}
          {showAllKinds && folder('views', views.length, true, () => relationRows(views, 'views'))}
          {showAllKinds && folder('materialized views', matviews.length, true, () => relationRows(matviews, 'materialized views'))}
          {showAllKinds && folder('sequences', s.sequences.length, false, () =>
            s.sequences.map((name) => {
              const key = `${schemaKey}/seq/${name}`;
              return (
                <Row
                  key={name}
                  depth={4}
                  selected={selection?.key === key}
                  icon={<ListOrdered size={15} className="ic-seq" />}
                  label={name}
                  onClick={() => {
                    onSelect({ key, connectionId: c.id, path: [...path, 'sequences', name] });
                    actions.openDdl(c, s.name, name, 'sequence');
                  }}
                  onContextMenu={(e) => objectMenu(e, ddlMenu(name, 'sequence'))}
                />
              );
            }),
          )}
          {showAllKinds && folder('routines', s.routines.length, false, () =>
            s.routines.map((routine: RoutineInfo) => {
              const key = `${schemaKey}/fn/${routine.name}(${routine.arguments})`;
              return (
                <Row
                  key={`${routine.name}(${routine.arguments})`}
                  depth={4}
                  selected={selection?.key === key}
                  icon={<FunctionSquare size={15} className="ic-fn" />}
                  label={<>{routine.name}<span className="muted">({routine.arguments})</span></>}
                  extra={routine.kind === 'function' ? undefined : routine.kind}
                  onClick={() => {
                    onSelect({ key, connectionId: c.id, path: [...path, 'routines', routine.name] });
                    actions.openDdl(c, s.name, routine.name, 'routine', routine.arguments);
                  }}
                  onContextMenu={(e) => objectMenu(e, ddlMenu(routine.name, 'routine', routine.arguments))}
                />
              );
            }),
          )}
        </>
      )}
    </>
  );
}

type RelationNodeProps = {
  connection: ConnectionSummary;
  schema: string;
  relation: RelationInfo;
  relKey: string;
  path: string[];
  isOpen: (key: string, fallback: boolean) => boolean;
  toggle: (key: string, fallback: boolean) => void;
  selection: ExplorerSelection | undefined;
  onSelect: (selection: ExplorerSelection) => void;
  actions: ExplorerActions;
  onContextMenu: (event: MouseEvent) => void;
};

/** A table or view. Clicking opens it in a table tab; the chevron reveals columns, keys and indexes. */
function RelationNode({ connection: c, schema, relation: r, relKey, path, isOpen, toggle, selection, onSelect, actions, onContextMenu }: RelationNodeProps) {
  const open = isOpen(relKey, false);
  const isView = r.kind === 'view' || r.kind === 'materialized view';
  const keys = r.indexes.filter((i) => i.primary || i.unique);
  return (
    <>
      <Row
        depth={4}
        expandable
        open={open}
        selected={selection?.key === relKey}
        icon={isView ? <Eye size={15} className="ic-view" /> : <Table2 size={15} className="ic-table" />}
        label={r.name}
        extra={formatEstimate(r.estimatedRows) || undefined}
        title={`${schema}.${r.name} (${r.kind})${r.estimatedRows !== null ? ` · ~${r.estimatedRows.toLocaleString()} rows (planner estimate)` : ''}\nClick to open · right-click for more`}
        onToggle={() => toggle(relKey, false)}
        onClick={() => {
          onSelect({ key: relKey, connectionId: c.id, path });
          actions.openTable(c, schema, r);
        }}
        onContextMenu={onContextMenu}
      />
      {open && (
        <>
          {r.columns.map((col) => (
            <Row
              key={`c:${col.name}`}
              depth={5}
              className="detail-row"
              icon={col.primaryKey ? <KeyRound size={14} className="ic-key" /> : <Columns2 size={14} className="ic-col" />}
              label={col.name}
              extra={`${col.type}${col.notNull ? '' : ' (nullable)'}`}
              title={col.default ? `default ${col.default}` : undefined}
            />
          ))}
          {keys.map((k) => (
            <Row key={`k:${k.name}`} depth={5} className="detail-row" icon={<KeyRound size={14} className="ic-key" />} label={k.name} extra={k.primary ? 'primary key' : 'unique'} title={k.definition} />
          ))}
          {r.foreignKeys.map((fk) => (
            <Row key={`f:${fk.name}`} depth={5} className="detail-row" icon={<Link2 size={14} className="ic-fk" />} label={fk.name} extra="foreign key" title={fk.definition} />
          ))}
          {r.indexes.filter((i) => !i.primary && !i.unique).map((i) => (
            <Row key={`i:${i.name}`} depth={5} className="detail-row" icon={<Rows3 size={14} className="ic-index" />} label={i.name} extra="index" title={i.definition} />
          ))}
          {isView && <Row depth={5} className="detail-row" icon={<FileCode2 size={14} className="ic-col" />} label="definition" extra="DDL" onClick={() => actions.openTable(c, schema, r, 'ddl')} />}
        </>
      )}
    </>
  );
}
