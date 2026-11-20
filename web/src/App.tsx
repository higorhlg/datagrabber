import { useState } from 'react';
import { EditorTabs } from './app/EditorTabs.tsx';
import { StatusBar } from './app/StatusBar.tsx';
import { consoleTabKey, ddlTabKey, type TableTab, tabBreadcrumb, tableTabKey } from './app/tabs.ts';
import { readySchema, useConnections } from './app/useConnections.ts';
import { useDragWidth } from './app/useDragWidth.ts';
import { useTabs } from './app/useTabs.ts';
import { useToasts } from './app/useToasts.ts';
import { ConnectionDialog } from './features/connections/ConnectionDialog.tsx';
import { ImportDialog } from './features/connections/ImportDialog.tsx';
import { PasswordCopyDialog } from './features/connections/PasswordCopyDialog.tsx';
import { PasswordDialog } from './features/connections/PasswordDialog.tsx';
import { type ConsoleRequest, ConsoleView } from './features/console/ConsoleView.tsx';
import { DatabaseExplorer, type ExplorerActions, type ExplorerSelection } from './features/explorer/DatabaseExplorer.tsx';
import { PropertiesDialog } from './features/explorer/PropertiesDialog.tsx';
import { DdlTab } from './features/table/DdlTab.tsx';
import { TableView } from './features/table/TableView.tsx';
import { api } from './lib/api.ts';
import { platform } from './lib/platform.ts';
import type { ConnectionConfig, ConnectionSummary, RelationInfo } from './lib/types.ts';
import { Modal } from './ui/Modal.tsx';

type Properties = { connection: ConnectionSummary; schema: string; relation: RelationInfo };

/** The window: explorer on the left, editor tabs on the right, status bar below, dialogs on top. */
export function App() {
  const { toasts, notify } = useToasts();
  const db = useConnections(notify);
  const tabs = useTabs();
  const [explorerWidth, startExplorerResize] = useDragWidth(330, 220, 640);
  const [selection, setSelection] = useState<ExplorerSelection>();
  const [editing, setEditing] = useState<{ connection?: ConnectionConfig }>();
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ConnectionSummary>();
  const [properties, setProperties] = useState<Properties>();

  const connectionOf = (id: string) => db.connections.find((c) => c.id === id);

  const openConsole = (connection: ConnectionSummary) => {
    tabs.open({ key: consoleTabKey(connection.id), kind: 'console', connectionId: connection.id });
    db.ensureConnected(connection);
  };

  const openTable = (connection: ConnectionSummary, schema: string, relation: RelationInfo, mode: 'data' | 'ddl' = 'data') =>
    tabs.open({
      key: tableTabKey(connection.id, schema, relation.name),
      kind: 'table',
      connectionId: connection.id,
      schema,
      relation,
      mode,
    });

  const sendToConsole = (connection: ConnectionSummary, kind: ConsoleRequest['kind'], sql: string) => {
    openConsole(connection);
    tabs.sendToConsole(connection.id, kind, sql);
  };

  const saveFile = async (fileName: string, contents: string) => {
    try {
      notify(`Saved ${await api.saveExport(fileName, contents)}`);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  /** Latest introspected version of a table tab's relation (falls back to the snapshot taken when opened). */
  const freshRelation = (tab: TableTab) =>
    readySchema(db.schemas[tab.connectionId])
      ?.schemas.find((s) => s.name === tab.schema)
      ?.relations.find((r) => r.name === tab.relation.name) ?? tab.relation;

  const explorerActions: ExplorerActions = {
    openConsole,
    openTable,
    openDdl: (connection, schema, name, ddlKind, args) =>
      tabs.open({
        key: ddlTabKey(connection.id, schema, name, args),
        kind: 'ddl',
        connectionId: connection.id,
        schema,
        name,
        ddlKind,
        args,
      }),
    showProperties: (connection, schema, relation) => setProperties({ connection, schema, relation }),
    insertIntoConsole: (connection, sql) => sendToConsole(connection, 'insert', sql),
    connect: (connection) => void db.ensureConnected(connection),
    disconnect: db.disconnect,
    refreshSchema: (connection) => db.loadSchema(connection.id),
    edit: (connection) => setEditing({ connection }),
    forgetPassword: db.forgetPassword,
    remove: setConfirmDelete,
    newConnection: () => setEditing({}),
    importDatagrip: () => setImporting(true),
    copyDatagripPasswords: (connection) =>
      connection ? void db.copyDatagripPasswords([connection.id]) : db.setPasswordCopy({ phase: 'confirm' }),
    notify,
  };

  const activeTab = tabs.tabs.find((t) => t.key === tabs.activeKey);
  const activeConnection = connectionOf(activeTab?.connectionId ?? selection?.connectionId ?? '');
  const activeTabConnection = activeTab && connectionOf(activeTab.connectionId);
  const breadcrumb = activeTab && activeTabConnection ? tabBreadcrumb(activeTab, activeTabConnection) : (selection?.path ?? []);

  return (
    <div className="app" style={{ gridTemplateColumns: `${explorerWidth}px 6px 1fr` }}>
      <DatabaseExplorer
        connections={db.connections}
        schemas={db.schemas}
        phases={db.phases}
        connectErrors={db.connectErrors}
        selection={selection}
        onSelect={setSelection}
        actions={explorerActions}
      />
      <div className="column-splitter" onMouseDown={startExplorerResize} role="separator" aria-orientation="vertical" />
      <main className="main island">
        {tabs.tabs.length === 0 ? (
          <div className="welcome">
            <h1>datagrabber</h1>
            <p className="muted">Click a table in the explorer to open it, or double-click a connection for a query console.</p>
            <p className="muted small">
              {platform.shortcuts.run} runs the statement at the cursor · {platform.shortcuts.runAll} runs everything · ★ saves a query for
              later
            </p>
          </div>
        ) : (
          <>
            <EditorTabs
              tabs={tabs.tabs}
              activeKey={tabs.activeKey}
              connectionOf={connectionOf}
              onActivate={tabs.setActiveKey}
              onClose={tabs.close}
            />
            <div className="editor-area">
              {tabs.tabs.map((tab) => {
                const connection = connectionOf(tab.connectionId);
                if (!connection) return null;
                const visible = tab.key === tabs.activeKey;
                const reconnect = db.reconnectFor(connection);
                if (tab.kind === 'console') {
                  return (
                    <ConsoleView
                      key={tab.key}
                      connection={connection}
                      schema={readySchema(db.schemas[connection.id])}
                      visible={visible}
                      request={tabs.consoleRequests[connection.id]}
                      ensureConnected={reconnect}
                      onSchemaChanged={() => db.loadSchema(connection.id)}
                      onSaveFile={saveFile}
                      notify={notify}
                    />
                  );
                }
                if (tab.kind === 'table') {
                  return (
                    <TableView
                      key={tab.key}
                      connection={connection}
                      schema={tab.schema}
                      relation={freshRelation(tab)}
                      mode={tab.mode}
                      visible={visible}
                      onModeChange={(mode) => tabs.setTableMode(tab.key, mode)}
                      ensureConnected={reconnect}
                      openInConsole={(sql) => sendToConsole(connection, 'insert', sql)}
                      onSaveFile={saveFile}
                      notify={notify}
                    />
                  );
                }
                return (
                  <DdlTab
                    key={tab.key}
                    connection={connection}
                    schema={tab.schema}
                    name={tab.name}
                    kind={tab.ddlKind}
                    args={tab.args}
                    visible={visible}
                    ensureConnected={reconnect}
                  />
                );
              })}
            </div>
          </>
        )}
      </main>
      <StatusBar
        breadcrumb={breadcrumb}
        connection={activeConnection}
        serverVersion={activeConnection ? db.serverVersions[activeConnection.id] : undefined}
      />
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
          onSaved={async (saved) => {
            setEditing(undefined);
            await db.afterSave(saved);
            notify(`Saved ${saved.name}`);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(count) => {
            setImporting(false);
            db.refresh();
            notify(`Imported ${count} connection${count === 1 ? '' : 's'} from DataGrip`);
          }}
        />
      )}
      {db.prompt && (
        <PasswordDialog
          connection={db.prompt.connection}
          error={db.prompt.error}
          onSubmit={db.submitPassword}
          onUseDatagrip={db.prompt.connection.datagripUuid ? db.connectWithDatagripPassword : undefined}
          onCancel={db.cancelPassword}
        />
      )}
      {db.passwordCopy && !db.prompt && (
        <PasswordCopyDialog
          state={db.passwordCopy}
          pendingCount={db.connections.filter((c) => c.datagripUuid && !c.passwordSaved).length}
          onStart={() => db.copyDatagripPasswords()}
          onClose={() => db.setPasswordCopy(undefined)}
        />
      )}
      {confirmDelete && (
        <Modal
          title={`Delete ${confirmDelete.name}?`}
          onClose={() => setConfirmDelete(undefined)}
          footer={
            <>
              <span className="spacer" />
              <button type="button" className="ghost" onClick={() => setConfirmDelete(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary danger-fill"
                onClick={async () => {
                  setConfirmDelete(undefined);
                  tabs.closeConnection(confirmDelete.id);
                  await db.remove(confirmDelete);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p>This removes the connection, its console, saved queries and saved password. The database itself is not touched.</p>
        </Modal>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
