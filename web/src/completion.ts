import type * as Monaco from 'monaco-editor';
import type { DatabaseSchema, RelationInfo } from '../../shared/types.ts';
import { findTableReferences, normalizeIdent, resolveQualifier } from '../../shared/sql-context.ts';
import { statementAt } from '../../shared/sql-split.ts';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'LATERAL', 'ON', 'USING',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'AS', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
  'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'WITH', 'RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'RETURNING', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE SET',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'EXPLAIN', 'EXPLAIN ANALYZE', 'COALESCE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'NOW()', 'CAST', 'INTERVAL',
  'TRUE', 'FALSE', 'FILTER', 'OVER', 'PARTITION BY', 'ROW_NUMBER()', 'STRING_AGG', 'ARRAY_AGG', 'JSONB_AGG',
];

const SIMPLE_IDENT = /^[a-z_][a-z0-9_$]*$/;
const RESERVED = new Set(KEYWORDS.flatMap((k) => k.toLowerCase().split(' ')).concat(['user', 'table', 'order', 'group', 'select', 'default', 'check', 'column']));

/** Quotes an identifier only when PostgreSQL requires it (upper case, symbols, or a reserved word). */
export function quoteIdent(name: string): string {
  return SIMPLE_IDENT.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

const schemasByModel = new Map<string, DatabaseSchema>();

/**
 * Tells the completion provider which database schema backs an editor model.
 * @param model - the editor's text model
 * @param schema - introspected schema, or undefined to clear
 */
export function setModelSchema(model: Monaco.editor.ITextModel, schema: DatabaseSchema | undefined): void {
  if (schema) schemasByModel.set(model.uri.toString(), schema);
  else schemasByModel.delete(model.uri.toString());
}

/**
 * Finds a relation by name, honoring an explicit schema or falling back to search_path order.
 * @param db - introspected schema
 * @param table - normalized table name
 * @param schemaName - normalized schema name, when qualified
 */
function findRelation(db: DatabaseSchema, table: string, schemaName?: string): RelationInfo | undefined {
  const order = schemaName ? [schemaName] : [...db.searchPath, ...db.schemas.map((s) => s.name)];
  for (const name of order) {
    const relation = db.schemas.find((s) => s.name === name)?.relations.find((r) => r.name === table);
    if (relation) return relation;
  }
  return undefined;
}

/**
 * Reads the qualifier before a trailing dot at the cursor (`o.` → "o", `"MySchema".` → "MySchema").
 * @param before - statement text up to the cursor
 */
function qualifierBeforeCursor(before: string): string | undefined {
  const match = /("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*[A-Za-z0-9_$"]*$/.exec(before);
  return match ? normalizeIdent(match[1]) : undefined;
}

type ItemFactory = (label: string, kind: Monaco.languages.CompletionItemKind, detail: string, insertText?: string, sortPrefix?: string) => Monaco.languages.CompletionItem;

/**
 * Suggestions after `qualifier.`: relations of a schema, or columns of an aliased/named table.
 * @param db - introspected schema
 * @param qualifier - normalized identifier before the dot
 * @param statementText - the statement being edited, for alias resolution
 */
function qualifiedSuggestions(db: DatabaseSchema, qualifier: string, statementText: string, item: ItemFactory, kinds: typeof Monaco.languages.CompletionItemKind): Monaco.languages.CompletionItem[] {
  const schema = db.schemas.find((s) => s.name === qualifier);
  const reference = resolveQualifier(findTableReferences(statementText), qualifier);
  const relation = reference ? findRelation(db, reference.table, reference.schema) : findRelation(db, qualifier);
  const items: Monaco.languages.CompletionItem[] = [];
  if (relation) {
    for (const column of relation.columns) items.push(item(column.name, kinds.Field, `${column.type}${column.primaryKey ? ' · PK' : ''}`, quoteIdent(column.name), '0'));
  }
  if (schema) {
    for (const r of schema.relations) items.push(item(r.name, r.kind === 'table' ? kinds.Class : kinds.Interface, r.kind, quoteIdent(r.name), '1'));
  }
  return items;
}

/**
 * Suggestions with no qualifier: columns of tables used in the statement first, then tables
 * (search_path ones unqualified), schemas and keywords.
 */
function unqualifiedSuggestions(db: DatabaseSchema, statementText: string, item: ItemFactory, kinds: typeof Monaco.languages.CompletionItemKind): Monaco.languages.CompletionItem[] {
  const items: Monaco.languages.CompletionItem[] = [];
  const seenColumns = new Set<string>();
  for (const reference of findTableReferences(statementText)) {
    const relation = findRelation(db, reference.table, reference.schema);
    for (const column of relation?.columns ?? []) {
      if (seenColumns.has(column.name)) continue;
      seenColumns.add(column.name);
      items.push(item(column.name, kinds.Field, `${column.type} · ${relation?.name}`, quoteIdent(column.name), '0'));
    }
  }
  for (const schema of db.schemas) {
    const onPath = db.searchPath.includes(schema.name);
    for (const r of schema.relations) {
      const insert = onPath ? quoteIdent(r.name) : `${quoteIdent(schema.name)}.${quoteIdent(r.name)}`;
      items.push(item(onPath ? r.name : `${schema.name}.${r.name}`, r.kind === 'table' ? kinds.Class : kinds.Interface, `${r.kind} · ${schema.name}`, insert, '1'));
    }
    items.push(item(schema.name, kinds.Module, 'schema', quoteIdent(schema.name), '2'));
  }
  for (const keyword of KEYWORDS) items.push(item(keyword, kinds.Keyword, 'keyword', keyword, '3'));
  return items;
}

/**
 * Registers the schema-aware SQL completion provider for the pgsql language. Call once.
 * @param monaco - the monaco namespace
 */
export function registerSqlCompletion(monaco: typeof Monaco): void {
  monaco.languages.registerCompletionItemProvider('pgsql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const db = schemasByModel.get(model.uri.toString());
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const item: ItemFactory = (label, kind, detail, insertText = label, sortPrefix = '9') => ({ label, kind, detail, insertText, range, sortText: `${sortPrefix}${label}` });
      const kinds = monaco.languages.CompletionItemKind;
      const fullText = model.getValue();
      const offset = model.getOffsetAt(position);
      const statement = statementAt(fullText, offset);
      const statementText = statement ? fullText.slice(statement.start, Math.max(statement.end, offset)) : '';
      const before = statement ? fullText.slice(statement.start, offset) : fullText.slice(0, offset);
      const qualifier = qualifierBeforeCursor(before);
      if (!db) return { suggestions: qualifier ? [] : KEYWORDS.map((k) => item(k, kinds.Keyword, 'keyword', k, '3')) };
      const suggestions = qualifier ? qualifiedSuggestions(db, qualifier, statementText, item, kinds) : unqualifiedSuggestions(db, statementText, item, kinds);
      return { suggestions };
    },
  });
}
