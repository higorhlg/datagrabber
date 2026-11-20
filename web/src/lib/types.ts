/**
 * How TLS is negotiated, mirroring libpq's sslmode:
 * - disable: plain TCP
 * - prefer: try TLS without certificate verification, fall back to plain TCP if the server refuses
 * - require: TLS without certificate verification
 * - verify-full: TLS with certificate and hostname verification
 */
export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

/** A saved PostgreSQL connection. Passwords are never part of this shape; they live in the OS keychain. */
export type ConnectionConfig = {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: SslMode;
  /** Every session starts with transactions read-only. A guard rail, not a permission boundary. */
  readOnly: boolean;
  color: string;
  /** True when a password for this connection is stored in the OS keychain. */
  passwordSaved: boolean;
  /** DataGrip data source uuid, set for imported connections so re-imports update instead of duplicating. */
  datagripUuid?: string;
};

export type ConnectionInput = Omit<ConnectionConfig, 'id' | 'passwordSaved'>;

/** A connection as listed to the client, with live session state. */
export type ConnectionSummary = ConnectionConfig & { connected: boolean };

export type ColumnInfo = {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  primaryKey: boolean;
};

export type RelationKind = 'table' | 'view' | 'materialized view' | 'partitioned table' | 'foreign table';

export type IndexInfo = { name: string; unique: boolean; primary: boolean; definition: string };

export type ForeignKeyInfo = { name: string; definition: string };

export type RelationInfo = {
  name: string;
  kind: RelationKind;
  estimatedRows: number | null;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
};

export type RoutineInfo = { name: string; arguments: string; kind: 'function' | 'procedure' | 'aggregate' | 'window' };

export type SchemaInfo = {
  name: string;
  relations: RelationInfo[];
  sequences: string[];
  routines: RoutineInfo[];
};

export type DatabaseSchema = {
  schemas: SchemaInfo[];
  searchPath: string[];
};

export type ResultColumn = { name: string; type: string };

/** Result of one statement (mirrors src-tauri/src/model.rs). Cell values are PostgreSQL's text representation, or null. */
export type QueryResult = {
  columns: ResultColumn[];
  rows: (string | null)[][];
  /** True when more rows existed than the requested maximum. */
  truncated: boolean;
  /** Leading keyword(s) of the statement, e.g. "SELECT" or "CREATE TABLE". */
  command: string;
  rowCount: number | null;
  durationMs: number;
};

export type QueryError = {
  message: string;
  code?: string;
  /** 1-based character offset into the statement, as reported by PostgreSQL. */
  position?: number;
  detail?: string;
  hint?: string;
};

export type HistoryEntry = {
  id: string;
  connectionId: string;
  sql: string;
  at: string;
  durationMs: number;
  ok: boolean;
  rowCount: number | null;
};

/** A DataGrip data source as seen by the importer, before it becomes a connection. */
export type DatagripCandidate = {
  uuid: string;
  name: string;
  driver: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  sslMode?: SslMode;
  importable: boolean;
  /** Why the data source cannot be imported, when importable is false. */
  reason?: string;
  /** Id of the existing connection this would update. */
  existingId?: string;
};

/** A query starred to rerun later, scoped to one connection. */
export type SavedQuery = {
  id: string;
  connectionId: string;
  name: string;
  sql: string;
  createdAt: string;
};

/** What a table tab asks for: one page of a table or view. */
export type TablePageRequest = {
  schema: string;
  table: string;
  filter?: string;
  orderBy?: string;
  limit: number;
  offset: number;
};
