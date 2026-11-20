import type { ConnectionSummary, RelationInfo } from '../lib/types.ts';

/** An editor tab: a connection's console, a table/view, or the DDL of a sequence or routine. */
export type Tab =
  | { key: string; kind: 'console'; connectionId: string }
  | { key: string; kind: 'table'; connectionId: string; schema: string; relation: RelationInfo; mode: 'data' | 'ddl' }
  | { key: string; kind: 'ddl'; connectionId: string; schema: string; name: string; ddlKind: 'sequence' | 'routine'; args?: string };

export type TableTab = Extract<Tab, { kind: 'table' }>;

export const consoleTabKey = (connectionId: string) => `console:${connectionId}`;
export const tableTabKey = (connectionId: string, schema: string, name: string) => `table:${connectionId}:${schema}.${name}`;
export const ddlTabKey = (connectionId: string, schema: string, name: string, args?: string) =>
  `ddl:${connectionId}:${schema}.${name}(${args ?? ''})`;

/** Explorer folder a relation is listed under. */
export function folderOf(relation: RelationInfo): string {
  if (relation.kind === 'view') return 'views';
  if (relation.kind === 'materialized view') return 'materialized views';
  return 'tables';
}

/** Tab title, DataGrip style: `order [connection]` for objects, the connection name for consoles. */
export function tabLabel(tab: Tab, connection: ConnectionSummary): string {
  if (tab.kind === 'console') return connection.name;
  return `${tab.kind === 'table' ? tab.relation.name : tab.name} [${connection.name}]`;
}

/** Location of a tab for the status bar: connection › database › schema › folder › object. */
export function tabBreadcrumb(tab: Tab, connection: ConnectionSummary): string[] {
  const base = [connection.name, connection.database];
  if (tab.kind === 'console') return [...base, 'console'];
  if (tab.kind === 'table') return [...base, tab.schema, folderOf(tab.relation), tab.relation.name];
  return [...base, tab.schema, tab.ddlKind === 'sequence' ? 'sequences' : 'routines', tab.name];
}
