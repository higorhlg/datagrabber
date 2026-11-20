import type { QueryResult } from '../../shared/types.ts';

/** Quotes a CSV field when it contains a delimiter, quote or newline (RFC 4180). */
function csvField(value: string | null): string {
  if (value === null) return '';
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serializes rows as CSV with a header line; NULL becomes an empty field. */
export function toCsv(result: Pick<QueryResult, 'columns' | 'rows'>): string {
  const lines = [result.columns.map((c) => csvField(c.name)).join(',')];
  for (const row of result.rows) lines.push(row.map(csvField).join(','));
  return lines.join('\n');
}

/** Serializes rows as tab-separated values, which paste cleanly into spreadsheets. */
export function toTsv(result: Pick<QueryResult, 'columns' | 'rows'>): string {
  const clean = (v: string | null) => (v ?? '').replace(/[\t\n\r]/g, ' ');
  return [result.columns.map((c) => clean(c.name)).join('\t'), ...result.rows.map((r) => r.map(clean).join('\t'))].join('\n');
}

/** Serializes rows as a JSON array of objects keyed by column name (later duplicates win). */
export function toJson(result: Pick<QueryResult, 'columns' | 'rows'>): string {
  const objects = result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c.name, row[i]])));
  return JSON.stringify(objects, null, 2);
}

/**
 * Builds a multi-row INSERT statement for the rows, with every value as a quoted literal
 * (PostgreSQL casts literals to the column types on insert).
 * @param table - target table name, already quoted/qualified
 */
export function toInsertSql(result: Pick<QueryResult, 'columns' | 'rows'>, table: string): string {
  const literal = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
  const columns = result.columns.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(', ');
  const values = result.rows.map((r) => `  (${r.map(literal).join(', ')})`).join(',\n');
  return `INSERT INTO ${table} (${columns}) VALUES\n${values};`;
}
