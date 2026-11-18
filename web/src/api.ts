import { invoke } from '@tauri-apps/api/core';
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionSummary,
  DatabaseSchema,
  DatagripCandidate,
  HistoryEntry,
  QueryError,
  QueryResult,
  SavedQuery,
  TablePageRequest,
} from '../../shared/types.ts';

/** A backend failure, carrying the flags the UI reacts to (needsPassword, notConnected). */
export class ApiError extends Error {
  needsPassword: boolean;
  notConnected: boolean;

  constructor(message: string, flags: { needsPassword?: boolean; notConnected?: boolean } = {}) {
    super(message);
    this.needsPassword = flags.needsPassword === true;
    this.notConnected = flags.notConnected === true;
  }
}

/**
 * Calls a Rust command, turning its serialized error into an ApiError.
 * @param command - command name registered in src-tauri/src/lib.rs
 * @param args - camelCase arguments (Tauri maps them to the command's snake_case parameters)
 */
async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (error && typeof error === 'object' && 'message' in error) {
      const e = error as { message: string; needsPassword?: boolean; notConnected?: boolean };
      throw new ApiError(e.message, e);
    }
    throw new ApiError(String(error));
  }
}

export type PasswordChoice = { password?: string; savePassword?: boolean };
export type RunResponse = { ok: true; result: QueryResult } | { ok: false; error: QueryError };
export type TablePageResponse = { ok: true; result: QueryResult; sql: string } | { ok: false; error: QueryError; sql: string };
export type DdlKind = 'relation' | 'sequence' | 'routine';
/** Outcome of copying one connection's password from DataGrip (the password itself is never returned). */
export type PasswordCopyResult = {
  id: string;
  name: string;
  status: 'copied' | 'already-saved' | 'not-found' | 'not-imported' | 'unavailable' | 'error';
  message?: string | null;
};

export const api = {
  listConnections: () => call<ConnectionSummary[]>('list_connections'),
  createConnection: (input: ConnectionInput, choice: PasswordChoice = {}) => call<ConnectionConfig>('create_connection', { input, choice }),
  updateConnection: (id: string, input: ConnectionInput, choice: PasswordChoice = {}) => call<ConnectionConfig>('update_connection', { id, input, choice }),
  deleteConnection: (id: string) => call<void>('delete_connection', { id }),
  testConnection: (input: ConnectionInput, id?: string, password?: string) => call<{ serverVersion: string }>('test_connection', { input, id, password }),
  connect: (id: string, choice: PasswordChoice = {}) => call<{ serverVersion: string }>('connect', { id, choice }),
  disconnect: (id: string) => call<void>('disconnect', { id }),
  forgetPassword: (id: string) => call<void>('forget_password', { id }),
  schema: (id: string) => call<DatabaseSchema>('schema', { id }),
  run: (id: string, sql: string, maxRows: number) => call<RunResponse>('run_query', { id, sql, maxRows }),
  cancel: (id: string) => call<void>('cancel_query', { id }),
  tablePage: (id: string, request: TablePageRequest) => call<TablePageResponse>('table_page', { id, request }),
  cancelTableQuery: (id: string) => call<void>('cancel_table_query', { id }),
  tableCount: (id: string, schema: string, table: string, filter?: string) => call<number>('table_count', { id, schema, table, filter }),
  objectDdl: (id: string, schema: string, name: string, kind: DdlKind, args?: string) => call<string>('object_ddl', { id, schema, name, kind, arguments: args }),
  savedQueries: (id: string) => call<SavedQuery[]>('list_saved_queries', { id }),
  saveQuery: (id: string, name: string, sql: string) => call<SavedQuery>('save_query', { id, name, sql }),
  renameSavedQuery: (queryId: string, name: string) => call<void>('rename_saved_query', { queryId, name }),
  deleteSavedQuery: (queryId: string) => call<void>('delete_saved_query', { queryId }),
  history: (id: string) => call<HistoryEntry[]>('list_history', { id }),
  loadConsole: (id: string) => call<string>('load_console', { id }),
  saveConsole: (id: string, text: string) => call<void>('save_console', { id, text }),
  previewDatagrip: (dir?: string) => call<{ dir: string; candidates: DatagripCandidate[] }>('preview_datagrip', { dir }),
  importDatagrip: (uuids: string[], dir?: string) => call<ConnectionConfig[]>('import_datagrip', { uuids, dir }),
  copyDatagripPasswords: (ids?: string[]) => call<PasswordCopyResult[]>('copy_datagrip_passwords', { ids }),
  saveExport: (fileName: string, contents: string) => call<string>('save_export', { fileName, contents }),
  e2eConfig: () => call<Record<string, unknown> | null>('e2e_config'),
  e2eLog: (line: string) => call<void>('e2e_log', { line }),
  e2eReport: (ok: boolean, log: string[]) => call<void>('e2e_report', { ok, log }),
};
