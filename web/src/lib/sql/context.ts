import { stripComments } from './sql-split.ts';

/** A table mentioned in a statement, with the alias it is referenced by (if any). */
export type TableReference = {
  schema?: string;
  table: string;
  alias?: string;
};

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?`;
const RESERVED_AFTER_TABLE = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'on', 'using', 'group', 'order',
  'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'values', 'returning', 'window',
  'lateral', 'for', 'fetch', 'select', 'tablesample', 'default', 'as',
]);
const ALIAS = String.raw`(?:\s+(?:as\s+)?(?!(?:${[...RESERVED_AFTER_TABLE].join('|')})\b)(${IDENT}))?`;
const TABLE_INTRODUCER = new RegExp(String.raw`\b(?:from|join|update|into|table)\s+(?:only\s+)?${QUALIFIED}${ALIAS}`, 'gi');
const COMMA_TABLE = new RegExp(String.raw`,\s*${QUALIFIED}${ALIAS}`, 'gi');

/**
 * Normalizes an identifier the way PostgreSQL does: quoted identifiers keep their case,
 * unquoted ones fold to lower case.
 * @param raw - identifier as written in SQL
 */
export function normalizeIdent(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/""/g, '"');
  return raw.toLowerCase();
}

/**
 * Builds a reference from regex captures.
 * @param first - first identifier (schema, or table when unqualified)
 * @param second - table when qualified
 * @param alias - candidate alias
 */
function toReference(first: string, second: string | undefined, alias: string | undefined): TableReference {
  const reference: TableReference = second
    ? { schema: normalizeIdent(first), table: normalizeIdent(second) }
    : { table: normalizeIdent(first) };
  if (alias) reference.alias = normalizeIdent(alias);
  return reference;
}

const FROM_CLAUSE_END = /\b(?:where|group|order|limit|offset|having|union|except|intersect|returning|window|fetch|for)\b/i;

/**
 * Returns the index where the FROM clause starting at `from` ends: the first clause keyword,
 * or the `)` that closes the enclosing subquery, both at paren depth 0.
 * @param sql - comment-free statement text
 * @param from - index right after the FROM keyword
 */
function fromClauseEnd(sql: string, from: number): number {
  let depth = 0;
  for (let i = from; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && /[A-Za-z]/.test(ch) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
      const word = FROM_CLAUSE_END.exec(sql.slice(i, i + 12));
      if (word && word.index === 0) return i;
    }
  }
  return sql.length;
}

/**
 * Finds the tables listed after top-level commas in a FROM clause (`from a x, b y join c on ..., d`).
 * @param sql - comment-free statement text
 * @param from - index right after the FROM keyword
 */
function collectCommaTables(sql: string, from: number): TableReference[] {
  const end = fromClauseEnd(sql, from);
  const references: TableReference[] = [];
  let depth = 0;
  for (let i = from; i < end; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      COMMA_TABLE.lastIndex = i;
      const match = COMMA_TABLE.exec(sql);
      if (match && match.index === i) references.push(toReference(match[1], match[2], match[3]));
    }
  }
  return references;
}

/**
 * Extracts table references (FROM/JOIN/UPDATE/INSERT INTO targets, including comma lists)
 * from a single statement. Heuristic: it does not resolve CTEs or subquery aliases.
 * @param statement - one SQL statement
 * @returns FROM/JOIN/UPDATE/INTO references in source order, followed by comma-listed tables
 */
export function findTableReferences(statement: string): TableReference[] {
  const sql = stripComments(statement);
  const references: TableReference[] = [];
  TABLE_INTRODUCER.lastIndex = 0;
  const commaTables: TableReference[] = [];
  for (let match = TABLE_INTRODUCER.exec(sql); match; match = TABLE_INTRODUCER.exec(sql)) {
    references.push(toReference(match[1], match[2], match[3]));
    if (/^from/i.test(match[0])) commaTables.push(...collectCommaTables(sql, match.index + 4));
  }
  return [...references, ...commaTables];
}

/**
 * Resolves a qualifier typed before a dot (`o.` or `orders.` or `public.`) to the table it names.
 * @param references - references found in the statement
 * @param qualifier - the identifier before the dot, already normalized
 * @returns the matching reference, or undefined
 */
export function resolveQualifier(references: TableReference[], qualifier: string): TableReference | undefined {
  return references.find((r) => r.alias === qualifier) ?? references.find((r) => r.table === qualifier);
}
