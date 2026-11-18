import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronRight, FileCode2, SquareTerminal, Table2, Eye, X } from 'lucide-react';
import type { ConnectionConfig, ConnectionSummary, DatabaseSchema, RelationInfo } from '../../shared/types.ts';
import { api, ApiError, type PasswordCopyResult } from './api.ts';
import { PasswordCopyDialog, type PasswordCopyState } from './components/PasswordCopyDialog.tsx';
import { ConnectionDialog } from './components/ConnectionDialog.tsx';
import { DatabaseExplorer, type ConnectionPhase, type ExplorerSelection, type SchemaState } from './components/DatabaseExplorer.tsx';
import { DdlTab } from './components/DdlTab.tsx';
import { ImportDialog } from './components/ImportDialog.tsx';
import { Modal } from './components/Modal.tsx';
import { PasswordDialog } from './components/PasswordDialog.tsx';
import { PropertiesDialog } from './components/PropertiesDialog.tsx';
import { TableView } from './components/TableView.tsx';
import { Workspace, type WorkspaceRequest } from './components/Workspace.tsx';
import { runSelfTestIfRequested } from './selftest.ts';

/** An editor tab: a connection's console, a table/view, or the DDL of a sequence or routine. */
export type Tab =
  | { key: string; kind: 'console'; connectionId: string }
  | { key: string; kind: 'table'; connectionId: string; schema: string; relation: RelationInfo; mode: 'data' | 'ddl' }
  | { key: string; kind: 'ddl'; connectionId: string; schema: string; name: string; ddlKind: 'sequence' | 'routine'; args?: string };

type PasswordPrompt = { connection: ConnectionConfig; error?: string; resolve: (connected: boolean) => void };
type Toast = { id: number; message: string };
type Properties = { connection: ConnectionSummary; schema: string; relation: RelationInfo };

const consoleKey = (connectionId: string) => `console:${connectionId}`;

/** The introspected schema when it has finished loading. */
function readySchema(state: SchemaState | undefined): DatabaseSchema | undefined {
  return state?.status === 'ready' ? state.schema : undefined;
}

/** Folder a relation appears under in the explorer, for breadcrumbs. */
function folderOf(relation: RelationInfo): string {
  if (relation.kind === 'view') return 'views';
  if (relation.kind === 'materialized view') return 'materialized views';
  return 'tables';
}

export function App() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [schemas, setSchemas] = useState<Record<string, SchemaState | undefined>>({});
  const [serverVersions, setServerVersions] = useState<Record<string, string>>({});
  const [phases, setPhases] = useState<Record<string, ConnectionPhase | undefined>>({});
  const [connectErrors, setConnectErrors] = useState<Record<string, string | undefined>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string>();
  const [selection, setSelection] = useState<ExplorerSelection>();
  const [requests, setRequests] = useState<Record<string, WorkspaceRequest | undefined>>({});
  const [editing, setEditing] = useState<{ connection?: ConnectionConfig }>();
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ConnectionSummary>();
  const [prompt, setPrompt] = useState<PasswordPrompt>();
  const [properties, setProperties] = useState<Properties>();
  const [passwordCopy, setPasswordCopy] = useState<PasswordCopyState>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [explorerWidth, setExplorerWidth] = useState(330);
  const connecting = useRef(new Map<string, Promise<boolean>>());

  const notify = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setConnections(await api.listConnections());
    } catch (error) {
      notify((error as Error).message);
    }
  }, [notify]);

  useEffect(() => {
    refresh();
    runSelfTestIfRequested();
  }, [refresh]);

  const loadSchema = useCallback(async (id: string) => {
    setSchemas((s) => {
      const current = s[id];
      return { ...s, [id]: current?.status === 'ready' ? { ...current, refreshing: true } : { status: 'loading' } };
    });
    try {
      const schema = await api.schema(id);
      setSchemas((s) => ({ ...s, [id]: { status: 'ready', schema } }));
    } catch (error) {
      setSchemas((s) => ({ ...s, [id]: { status: 'error', message: (error as Error).message } }));
    }
  }, []);

  /** Shows the password dialog; resolves true once a connect with the typed password succeeds. */
  const askPassword = (connection: ConnectionConfig, error?: string) => new Promise<boolean>((resolve) => setPrompt({ connection, error, resolve }));

  const submitPassword = async (password: string, savePassword: boolean) => {
    if (!prompt) return;
    try {
      const info = await api.connect(prompt.connection.id, { password, savePassword });
      setServerVersions((v) => ({ ...v, [prompt.connection.id]: info.serverVersion }));
      prompt.resolve(true);
      setPrompt(undefined);
    } catch (error) {
      setPrompt({ ...prompt, error: (error as Error).message });
    }
  };

  /** Copies DataGrip's Keychain passwords (all imported connections, or the given ones). */
  const runPasswordCopy = async (ids?: string[]): Promise<PasswordCopyResult[]> => {
    setPasswordCopy({ phase: 'running' });
    try {
      const results = await api.copyDatagripPasswords(ids);
      setPasswordCopy({ phase: 'done', results });
      await refresh();
      return results;
    } catch (error) {
      setPasswordCopy(undefined);
      notify((error as Error).message);
      return [];
    }
  };

  /** "Use the password saved in DataGrip" in the password prompt: copy it, then connect with it. */
  const useDatagripPassword = async () => {
    if (!prompt) return;
    const current = prompt;
    const [result] = await runPasswordCopy([current.connection.id]);
    setPasswordCopy(undefined);
    if (result?.status !== 'copied') {
      setPrompt({ ...current, error: result?.message ?? 'DataGrip has no saved password for this connection.' });
      return;
    }
    try {
      const info = await api.connect(current.connection.id);
      setServerVersions((v) => ({ ...v, [current.connection.id]: info.serverVersion }));
      current.resolve(true);
      setPrompt(undefined);
    } catch (error) {
      setPrompt({ ...current, error: (error as Error).message });
    }
  };

  /**
   * Makes sure a session is open, asking for a password when none is saved or it was rejected.
   * Concurrent callers for the same connection share one attempt.
   */
  const ensureConnected = useCallback(
    (connection: ConnectionConfig): Promise<boolean> => {
      const pending = connecting.current.get(connection.id);
      if (pending) return pending;
      const setPhase = (phase: ConnectionPhase | undefined) => setPhases((p) => ({ ...p, [connection.id]: phase }));
      const attempt = (async () => {
        let connected = false;
        setPhase('connecting');
        setConnectErrors((e) => ({ ...e, [connection.id]: undefined }));
        try {
          const info = await api.connect(connection.id);
          setServerVersions((v) => ({ ...v, [connection.id]: info.serverVersion }));
          connected = true;
        } catch (error) {
          if (error instanceof ApiError && error.needsPassword) {
            setPhase('password');
            connected = await askPassword(connection, error.message === 'Password required' ? undefined : error.message);
          } else {
            setConnectErrors((e) => ({ ...e, [connection.id]: (error as Error).message }));
          }
        }
        if (connected) {
          if (!readySchema(schemas[connection.id])) loadSchema(connection.id);
          await refresh();
        }
        return connected;
      })().finally(() => {
        setPhase(undefined);
        connecting.current.delete(connection.id);
      });
      connecting.current.set(connection.id, attempt);
      return attempt;
    },
    [loadSchema, notify, refresh, schemas],
  );

  const ensureConnectedRef = useRef(ensureConnected);
  ensureConnectedRef.current = ensureConnected;
  /** Stable per-connection reconnect callbacks, so tabs don't reload when App re-renders. */
  const reconnectors = useRef(new Map<string, () => Promise<boolean>>());
  const reconnectFor = (connection: ConnectionConfig) => {
    let fn = reconnectors.current.get(connection.id);
    if (!fn) {
      fn = () => ensureConnectedRef.current(connection);
      reconnectors.current.set(connection.id, fn);
    }
    return fn;
  };

  const openTab = (tab: Tab) => {
    setTabs((current) => (current.some((t) => t.key === tab.key) ? current.map((t) => (t.key === tab.key && tab.kind === 'table' && t.kind === 'table' ? { ...t, mode: tab.mode } : t)) : [...current, tab]));
    setActiveKey(tab.key);
  };

  const openConsole = (connection: ConnectionSummary) => {
    openTab({ key: consoleKey(connection.id), kind: 'console', connectionId: connection.id });
    ensureConnected(connection);
  };

  const openTable = (connection: ConnectionSummary, schema: string, relation: RelationInfo, mode: 'data' | 'ddl' = 'data') => {
    openTab({ key: `table:${connection.id}:${schema}.${relation.name}`, kind: 'table', connectionId: connection.id, schema, relation, mode });
  };

  const openDdl = (connection: ConnectionSummary, schema: string, name: string, ddlKind: 'sequence' | 'routine', args?: string) => {
    openTab({ key: `ddl:${connection.id}:${schema}.${name}(${args ?? ''})`, kind: 'ddl', connectionId: connection.id, schema, name, ddlKind, args });
  };

  const sendToConsole = (connection: ConnectionSummary, kind: WorkspaceRequest['kind'], sql: string) => {
    openConsole(connection);
    setRequests((r) => ({ ...r, [connection.id]: { kind, sql, nonce: Date.now() } }));
  };

  const closeTab = (key: string) => {
    setTabs((current) => {
      const index = current.findIndex((t) => t.key === key);
      const next = current.filter((t) => t.key !== key);
      if (activeKey === key) setActiveKey(next[Math.min(index, next.length - 1)]?.key);
      return next;
    });
  };

  const connect = (connection: ConnectionSummary) => {
    ensureConnected(connection);
  };

  const disconnect = async (connection: ConnectionSummary) => {
    await api.disconnect(connection.id);
    setSchemas((s) => ({ ...s, [connection.id]: undefined }));
    refresh();
  };

  const deleteConnection = async (connection: ConnectionSummary) => {
    await api.deleteConnection(connection.id);
    setTabs((current) => current.filter((t) => t.connectionId !== connection.id));
    setConfirmDelete(undefined);
    refresh();
    notify(`Deleted ${connection.name}`);
  };

  const saveFile = async (fileName: string, contents: string) => {
    try {
      notify(`Saved ${await api.saveExport(fileName, contents)}`);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  /** Latest introspected version of a table tab's relation (falls back to the snapshot taken when opened). */
  const freshRelation = (tab: Extract<Tab, { kind: 'table' }>) =>
    readySchema(schemas[tab.connectionId])?.schemas.find((s) => s.name === tab.schema)?.relations.find((r) => r.name === tab.relation.name) ?? tab.relation;

  const startExplorerResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    const onMove = (e: MouseEvent) => setExplorerWidth(Math.min(640, Math.max(220, startWidth + e.clientX - startX)));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const connectionOf = (id: string) => connections.find((c) => c.id === id);
  const activeTab = tabs.find((t) => t.key === activeKey);
  const activeConnection = activeTab ? connectionOf(activeTab.connectionId) : connectionOf(selection?.connectionId ?? '');
  const breadcrumb: string[] = (() => {
    if (!activeTab) return selection?.path ?? [];
    const c = connectionOf(activeTab.connectionId);
    if (!c) return [];
    if (activeTab.kind === 'console') return [c.name, c.database, 'console'];
    if (activeTab.kind === 'table') return [c.name, c.database, activeTab.schema, folderOf(activeTab.relation), activeTab.relation.name];
    return [c.name, c.database, activeTab.schema, activeTab.ddlKind === 'sequence' ? 'sequences' : 'routines', activeTab.name];
  })();

  return (
    <div className="app" style={{ gridTemplateColumns: `${explorerWidth}px 6px 1fr` }}>
      <DatabaseExplorer
        connections={connections}
        schemas={schemas}
        phases={phases}
        connectErrors={connectErrors}
        selection={selection}
        onSelect={setSelection}
        actions={{
          openConsole,
          openTable,
          openDdl,
          showProperties: (connection, schema, relation) => setProperties({ connection, schema, relation }),
          insertIntoConsole: (connection, sql) => sendToConsole(connection, 'insert', sql),
          connect,
          disconnect,
          refreshSchema: (connection) => loadSchema(connection.id),
          edit: (connection) => setEditing({ connection }),
          forgetPassword: async (connection) => {
            await api.forgetPassword(connection.id);
            refresh();
            notify(`Forgot saved password for ${connection.name}`);
          },
          remove: setConfirmDelete,
          newConnection: () => setEditing({}),
          importDatagrip: () => setImporting(true),
          copyDatagripPasswords: (connection) => (connection ? runPasswordCopy([connection.id]) : setPasswordCopy({ phase: 'confirm' })),
          notify,
        }}
      />
      <div className="column-splitter" onMouseDown={startExplorerResize} role="separator" aria-orientation="vertical" />
      <main className="main island">
        {tabs.length === 0 ? (
          <div className="welcome">
            <h1>datagrabber</h1>
            <p className="muted">Click a table in the explorer to open it, or double-click a connection for a query console.</p>
            <p className="muted small">⌘↵ runs the statement at the cursor · ⇧⌘↵ runs everything · ★ saves a query for later</p>
          </div>
        ) : (
          <>
            <nav className="editor-tabs" role="tablist">
              {tabs.map((tab) => {
                const c = connectionOf(tab.connectionId);
                if (!c) return null;
                const isView = tab.kind === 'table' && tab.relation.kind.includes('view');
                const icon = tab.kind === 'console' ? <SquareTerminal size={14} /> : tab.kind === 'table' ? isView ? <Eye size={14} /> : <Table2 size={14} /> : <FileCode2 size={14} />;
                const label = tab.kind === 'console' ? c.name : `${tab.kind === 'table' ? tab.relation.name : tab.name} [${c.name}]`;
                return (
                  <div
                    key={tab.key}
                    role="tab"
                    aria-selected={tab.key === activeKey}
                    className={`editor-tab${tab.key === activeKey ? ' active' : ''}`}
                    style={{ ['--conn-color' as string]: c.color }}
                    onClick={() => setActiveKey(tab.key)}
                    onAuxClick={(e) => e.button === 1 && closeTab(tab.key)}
                    title={label}
                  >
                    <span className="tab-icon">{icon}</span>
                    <span className="tab-label">{label}</span>
                    <button className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(tab.key); }} aria-label={`Close ${label}`}><X size={12} /></button>
                  </div>
                );
              })}
            </nav>
            <div className="editor-area">
              {tabs.map((tab) => {
                const c = connectionOf(tab.connectionId);
                if (!c) return null;
                const visible = tab.key === activeKey;
                if (tab.kind === 'console') {
                  return (
                    <Workspace
                      key={tab.key}
                      connection={c}
                      schema={readySchema(schemas[c.id])}
                      visible={visible}
                      request={requests[c.id]}
                      ensureConnected={reconnectFor(c)}
                      onSchemaChanged={() => loadSchema(c.id)}
                      onSaveFile={saveFile}
                      notify={notify}
                    />
                  );
                }
                if (tab.kind === 'table') {
                  return (
                    <TableView
                      key={tab.key}
                      connection={c}
                      schema={tab.schema}
                      relation={freshRelation(tab)}
                      mode={tab.mode}
                      visible={visible}
                      onModeChange={(mode) => setTabs((current) => current.map((t) => (t.key === tab.key && t.kind === 'table' ? { ...t, mode } : t)))}
                      ensureConnected={reconnectFor(c)}
                      openInConsole={(sql) => sendToConsole(c, 'insert', sql)}
                      onSaveFile={saveFile}
                      notify={notify}
                    />
                  );
                }
                return <DdlTab key={tab.key} connection={c} schema={tab.schema} name={tab.name} kind={tab.ddlKind} args={tab.args} visible={visible} ensureConnected={reconnectFor(c)} />;
              })}
            </div>
          </>
        )}
      </main>
      <footer className="status-bar">
        <nav className="breadcrumb" aria-label="Location" data-testid="breadcrumb">
          <span>Database</span>
          {breadcrumb.map((part, i) => (
            <span key={`${i}-${part}`} className="crumb"><ChevronRight size={12} />{part}</span>
          ))}
        </nav>
        <span className="spacer" />
        {activeConnection && (
          <span className="status-right">
            {activeConnection.readOnly && <span className="badge ro">READ-ONLY</span>}
            <span className={`status-dot${activeConnection.connected ? ' on' : ''}`} />
            {activeConnection.connected ? `PostgreSQL ${serverVersions[activeConnection.id] ?? ''}` : 'disconnected'}
          </span>
        )}
      </footer>
      {properties && (
        <PropertiesDialog
          connection={properties.connection}
          schema={properties.schema}
          relation={properties.relation}
          onClose={() => setProperties(undefined)}
          onOpen={() => {
            openTable(properties.connection, properties.schema, properties.relation);
            setProperties(undefined);
          }}
          onShowDdl={() => {
            openTable(properties.connection, properties.schema, properties.relation, 'ddl');
            setProperties(undefined);
          }}
        />
      )}
      {editing && (
        <ConnectionDialog
          connection={editing.connection}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            setEditing(undefined);
            setSchemas((s) => ({ ...s, [saved.id]: undefined }));
            refresh();
            notify(`Saved ${saved.name}`);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(count) => {
            setImporting(false);
            refresh();
            notify(`Imported ${count} connection${count === 1 ? '' : 's'} from DataGrip`);
          }}
        />
      )}
      {prompt && (
        <PasswordDialog
          connection={prompt.connection}
          error={prompt.error}
          onSubmit={submitPassword}
          onUseDatagrip={prompt.connection.datagripUuid ? useDatagripPassword : undefined}
          onCancel={() => {
            prompt.resolve(false);
            setPrompt(undefined);
          }}
        />
      )}
      {passwordCopy && !prompt && (
        <PasswordCopyDialog
          state={passwordCopy}
          pendingCount={connections.filter((c) => c.datagripUuid && !c.passwordSaved).length}
          onStart={() => runPasswordCopy()}
          onClose={() => setPasswordCopy(undefined)}
        />
      )}
      {confirmDelete && (
        <Modal
          title={`Delete ${confirmDelete.name}?`}
          onClose={() => setConfirmDelete(undefined)}
          footer={<><span className="spacer" /><button className="ghost" onClick={() => setConfirmDelete(undefined)}>Cancel</button><button className="primary danger-fill" onClick={() => deleteConnection(confirmDelete)}>Delete</button></>}
        >
          <p>This removes the connection, its console, saved queries and saved password. The database itself is not touched.</p>
        </Modal>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className="toast">{t.message}</div>)}
      </div>
    </div>
  );
}
