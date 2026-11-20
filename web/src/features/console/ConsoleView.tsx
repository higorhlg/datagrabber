import { useCallback, useEffect, useRef, useState } from 'react';
import { Editor, type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { ConnectionSummary, DatabaseSchema } from '../../../shared/types.ts';
import { splitSql, statementAt, type SqlStatement } from '../../../shared/sql-split.ts';
import { api, ApiError } from '../api.ts';
import { setModelSchema } from '../completion.ts';
import { monaco } from '../monaco-setup.ts';
import { useEditorTheme } from '../theme.ts';
import { Play, ListVideo, Square, Star, History as HistoryIcon } from 'lucide-react';
import { LoadingMessage } from './Loading.tsx';
import { QueryLibrary } from './QueryLibrary.tsx';
import { ResultsPane, type ResultTab } from './ResultsPane.tsx';

/** A request from outside the editor: run a statement (e.g. table preview) or insert text. */
export type WorkspaceRequest = { kind: 'run' | 'insert'; sql: string; nonce: number };

type WorkspaceProps = {
  connection: ConnectionSummary;
  schema: DatabaseSchema | undefined;
  visible: boolean;
  request: WorkspaceRequest | undefined;
  ensureConnected: () => Promise<boolean>;
  onSchemaChanged: () => void;
  onSaveFile: (fileName: string, contents: string) => void;
  notify: (message: string) => void;
};

const MAX_ROW_CHOICES = [100, 500, 1000, 5000, 10000, 50000];
const SCHEMA_CHANGING = /^(CREATE|ALTER|DROP|COMMENT|RENAME|TRUNCATE|IMPORT)/;
const MAX_TABS = 20;

/** Short tab label for a statement: its first line, trimmed. */
function labelFor(index: number, sql: string): string {
  const firstLine = sql.split('\n').find((l) => l.trim() && !l.trim().startsWith('--'))?.trim() ?? sql.trim();
  return `${index + 1}: ${firstLine.length > 32 ? `${firstLine.slice(0, 32)}…` : firstLine}`;
}

const LIBRARY_KEY = 'datagrabber.console.libraryOpen';

/** Whether the History/Saved panel was left open last time. */
function readLibraryPreference(): boolean {
  try {
    return localStorage.getItem(LIBRARY_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Remembers whether the History/Saved panel is open. */
function writeLibraryPreference(open: boolean): void {
  try {
    localStorage.setItem(LIBRARY_KEY, String(open));
  } catch {
    // Preference is a convenience; ignore storage failures.
  }
}

/**
 * The console for one connection: a persisted SQL editor, run/cancel controls, results and history.
 * Stays mounted while hidden so editor state and results survive tab switches.
 */
export function Workspace({ connection, schema, visible, request, ensureConnected, onSchemaChanged, onSaveFile, notify }: WorkspaceProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor>(null);
  const [initialText, setInitialText] = useState<string>();
  const [tabs, setTabs] = useState<ResultTab[]>([]);
  const [activeTab, setActiveTab] = useState<string>();
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [maxRows, setMaxRows] = useState(500);
  const [showLibrary, setShowLibrary] = useState(() => readLibraryPreference());
  const [historyKey, setHistoryKey] = useState(0);
  const [saveRequest, setSaveRequest] = useState<{ sql: string; nonce: number }>();
  const [editorHeight, setEditorHeight] = useState(45);
  const saveTimer = useRef<number>(undefined);
  const theme = useEditorTheme();

  useEffect(() => {
    api.loadConsole(connection.id).then((text) => setInitialText(text || `-- ${connection.name}\nselect now();\n`)).catch(() => setInitialText(''));
  }, [connection.id, connection.name]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) setModelSchema(model, schema);
  }, [schema, initialText]);

  useEffect(() => {
    if (!running) return;
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed(Math.round(performance.now() - started)), 100);
    return () => window.clearInterval(timer);
  }, [running]);

  const persist = useCallback(
    (text: string) => {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => api.saveConsole(connection.id, text).catch(() => undefined), 400);
    },
    [connection.id],
  );

  /** Marks a SQL error in the editor at the server-reported character position. */
  const markError = (statement: SqlStatement | undefined, position: number | undefined, message: string) => {
    const model = editorRef.current?.getModel();
    if (!model || !statement) return;
    const start = model.getPositionAt(statement.start + Math.max(0, (position ?? 1) - 1));
    const end = position ? model.getWordAtPosition(start) : null;
    monaco.editor.setModelMarkers(model, 'postgres', [
      {
        severity: monaco.MarkerSeverity.Error,
        message,
        startLineNumber: start.lineNumber,
        startColumn: position ? start.column : 1,
        endLineNumber: start.lineNumber,
        endColumn: end ? end.endColumn : position ? start.column + 1 : model.getLineMaxColumn(start.lineNumber),
      },
    ]);
  };

  /**
   * Runs statements one after another, stopping at the first error. `statements` carry offsets
   * into the editor text so errors can be marked; external runs pass offset-less statements.
   */
  const runStatements = async (statements: SqlStatement[], fromEditor: boolean) => {
    if (running || statements.length === 0) return;
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelMarkers(model, 'postgres', []);
    if (!(await ensureConnected())) return;
    const batch: ResultTab[] = statements.map((s, i) => ({ id: `${Date.now()}-${i}`, label: labelFor(i, s.text), sql: s.text, status: 'running' }));
    setTabs(batch);
    setActiveTab(batch[0].id);
    setRunning(true);
    let schemaChanged = false;
    try {
      for (let i = 0; i < statements.length; i++) {
        setActiveTab(batch[i].id);
        let response;
        try {
          response = await api.run(connection.id, statements[i].text, maxRows);
        } catch (error) {
          if (error instanceof ApiError && error.notConnected && (await ensureConnected())) {
            response = await api.run(connection.id, statements[i].text, maxRows);
          } else {
            throw error;
          }
        }
        if (response.ok) {
          batch[i] = { ...batch[i], status: 'done', result: response.result };
          schemaChanged ||= SCHEMA_CHANGING.test(response.result.command);
        } else {
          batch[i] = { ...batch[i], status: 'error', error: response.error };
          if (fromEditor) markError(statements[i], response.error.position, response.error.message);
          setTabs(batch.slice(0, i + 1));
          return;
        }
        setTabs([...batch].slice(0, MAX_TABS));
      }
    } catch (error) {
      notify((error as Error).message);
      setTabs((current) => current.filter((t) => t.status !== 'running'));
    } finally {
      setRunning(false);
      setHistoryKey((k) => k + 1);
      if (schemaChanged) onSchemaChanged();
    }
  };

  /** ⌘↵: runs the selection's statements, or the statement under the cursor. */
  const runCurrent = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const selection = editor.getSelection();
    const text = model.getValue();
    if (selection && !selection.isEmpty()) {
      const offset = model.getOffsetAt(selection.getStartPosition());
      const selected = model.getValueInRange(selection);
      runStatements(splitSql(selected).map((s) => ({ ...s, start: s.start + offset, end: s.end + offset })), true);
      return;
    }
    const statement = statementAt(text, model.getOffsetAt(editor.getPosition()!));
    if (statement) runStatements([statement], true);
  };

  /** ⇧⌘↵: runs every statement in the console. */
  const runAll = () => {
    const text = editorRef.current?.getModel()?.getValue() ?? '';
    runStatements(splitSql(text), true);
  };

  /** The selection, or the statement under the cursor: what ⌘↵ would run. */
  const currentSql = (): string | undefined => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return undefined;
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) return model.getValueInRange(selection).trim();
    return statementAt(model.getValue(), model.getOffsetAt(editor.getPosition()!))?.text;
  };

  const toggleLibrary = (open: boolean) => {
    setShowLibrary(open);
    writeLibraryPreference(open);
  };

  /** ★ Save: opens the library's naming form for the current statement. */
  const saveCurrent = () => {
    const sql = currentSql();
    if (!sql) return notify('Put the cursor in a statement (or select one) to save it.');
    toggleLibrary(true);
    setSaveRequest({ sql, nonce: Date.now() });
  };

  const cancel = async () => {
    try {
      await api.cancel(connection.id);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const actions = useRef({ runCurrent, runAll });
  actions.current = { runCurrent, runAll };

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    const model = editor.getModel();
    if (model) setModelSchema(model, schema);
    editor.addAction({ id: 'datagrabber.run', label: 'Run statement', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => actions.current.runCurrent() });
    editor.addAction({ id: 'datagrabber.runAll', label: 'Run all statements', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter], run: () => actions.current.runAll() });
    editor.focus();
  };

  useEffect(() => {
    if (!request) return;
    if (request.kind === 'run') {
      runStatements([{ text: request.sql, start: 0, end: request.sql.length }], false);
      return;
    }
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const end = model.getFullModelRange().getEndPosition();
    const prefix = model.getValue().trim() ? '\n\n' : '';
    editor.executeEdits('datagrabber', [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: `${prefix}${request.sql}` }]);
    const last = model.getFullModelRange().getEndPosition();
    editor.setPosition(last);
    editor.revealPosition(last);
    editor.focus();
  }, [request?.nonce]);

  const runFromLibrary = (sql: string) => runStatements([{ text: sql, start: 0, end: sql.length }], false);

  const insertFromHistory = (sql: string) => {
    const editor = editorRef.current;
    const position = editor?.getPosition();
    if (!editor || !position) return;
    editor.executeEdits('history', [{ range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: `${sql};\n` }]);
    editor.focus();
  };

  const startResize = (event: React.MouseEvent) => {
    const container = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const onMove = (e: MouseEvent) => setEditorHeight(Math.min(85, Math.max(15, ((e.clientY - container.top) / container.height) * 100)));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="workspace" style={{ display: visible ? 'flex' : 'none', ['--conn-color' as string]: connection.color }}>
      <div className="toolbar">
        <button className="primary run" onClick={runCurrent} disabled={running} title="Run statement at cursor or selection (⌘↵)" data-testid="run"><Play size={13} fill="currentColor" /> Run</button>
        <button className="tool" onClick={runAll} disabled={running} title="Run all statements (⇧⌘↵)" data-testid="run-all"><ListVideo size={16} /></button>
        <button className="tool danger" onClick={cancel} disabled={!running} title="Cancel the running statement" data-testid="cancel"><Square size={14} fill="currentColor" /></button>
        <span className="tool-sep" />
        <button className="tool" onClick={saveCurrent} title="Save the current statement to this database's saved queries" data-testid="save-query"><Star size={15} /></button>
        {running && <span className="running-chip"><span className="spinner" /> <span className="mono">{(elapsed / 1000).toFixed(1)}s</span></span>}
        <span className="spacer" />
        <label className="small muted max-rows">
          Max rows
          <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}>
            {MAX_ROW_CHOICES.map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}
          </select>
        </label>
        <button className={`tool labeled${showLibrary ? ' pressed' : ''}`} onClick={() => toggleLibrary(!showLibrary)} data-testid="toggle-history" title="History and saved queries for this database"><HistoryIcon size={15} /> History</button>
        <span className="conn-chip" title={`${connection.user}@${connection.host}:${connection.port}/${connection.database}`}>
          <span className="conn-swatch" />
          {connection.database}
          {connection.readOnly && <span className="badge ro">READ-ONLY</span>}
        </span>
      </div>
      <div className="workspace-body">
        <div className="editor-and-results">
          <div className="editor" style={{ height: `${editorHeight}%` }}>
            {initialText === undefined && <LoadingMessage>Opening console…</LoadingMessage>}
            {initialText !== undefined && (
              <Editor
                path={`console-${connection.id}.sql`}
                defaultLanguage="pgsql"
                defaultValue={initialText}
                theme={theme}
                onMount={onMount}
                onChange={(value) => persist(value ?? '')}
                options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, wordBasedSuggestions: 'off', quickSuggestions: { other: true, strings: false, comments: false }, renderLineHighlight: 'line', fixedOverflowWidgets: true }}
              />
            )}
          </div>
          <div className="splitter" onMouseDown={startResize} role="separator" aria-orientation="horizontal" />
          <ResultsPane tabs={tabs} activeId={activeTab} onSelect={setActiveTab} onSaveFile={onSaveFile} notify={notify} onCancel={cancel} />
        </div>
        {showLibrary && (
          <QueryLibrary
            connectionId={connection.id}
            connectionName={connection.name}
            refreshKey={historyKey}
            saveRequest={saveRequest}
            onInsert={insertFromHistory}
            onRun={runFromLibrary}
            onClose={() => toggleLibrary(false)}
            notify={notify}
          />
        )}
      </div>
    </div>
  );
}
