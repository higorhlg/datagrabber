/** A statement located inside a larger SQL script, with offsets into that script. */
export type SqlStatement = {
  text: string;
  start: number;
  end: number;
};

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Returns the index just past a quoted region that starts at `start`.
 * Handles '' and "" doubling, and backslash escapes for E'' strings.
 * @param sql - the full script
 * @param start - index of the opening quote
 * @returns index after the closing quote, or sql.length when unterminated
 */
function skipQuoted(sql: string, start: number): number {
  const quote = sql[start];
  const allowsBackslash = quote === "'" && start > 0 && /[eE]/.test(sql[start - 1]) && !/[A-Za-z0-9_]/.test(sql[start - 2] ?? '');
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (allowsBackslash && ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/**
 * Returns the index just past a (possibly nested) block comment starting at `start`.
 * @param sql - the full script
 * @param start - index of the opening slash
 * @returns index after the closing delimiter, or sql.length when unterminated
 */
function skipBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql.startsWith('/*', i)) {
      depth++;
      i += 2;
    } else if (sql.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return sql.length;
}

/**
 * Returns the index just past a dollar-quoted body ($$...$$ or $tag$...$tag$), or -1 when
 * the `$` at `start` does not open a dollar quote (e.g. a $1 parameter).
 * @param sql - the full script
 * @param start - index of the `$`
 */
function skipDollarQuoted(sql: string, start: number): number {
  if (start > 0 && /[A-Za-z0-9_]/.test(sql[start - 1])) return -1;
  const match = DOLLAR_TAG.exec(sql.slice(start, start + 64));
  if (!match) return -1;
  const tag = match[0];
  const close = sql.indexOf(tag, start + tag.length);
  return close === -1 ? sql.length : close + tag.length;
}

/**
 * Returns true when the text holds only whitespace and comments, i.e. nothing worth sending to the server.
 * @param text - a candidate statement
 */
export function isBlankSql(text: string): boolean {
  return stripComments(text).trim() === '';
}

/**
 * Removes -- and block comments while leaving string literals untouched.
 * @param sql - SQL text
 * @returns the same text with comments replaced by a single space
 */
export function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const next = scanToken(sql, i);
    out += next.isComment ? ' ' : sql.slice(i, next.end);
    i = next.end;
  }
  return out;
}

type Token = { end: number; isComment: boolean; isSemicolon: boolean };

/**
 * Scans one lexical unit (comment, quoted region, dollar body, or single character).
 * @param sql - the full script
 * @param i - current index
 */
function scanToken(sql: string, i: number): Token {
  const ch = sql[i];
  if (ch === '-' && sql[i + 1] === '-') {
    const newline = sql.indexOf('\n', i);
    return { end: newline === -1 ? sql.length : newline, isComment: true, isSemicolon: false };
  }
  if (ch === '/' && sql[i + 1] === '*') {
    return { end: skipBlockComment(sql, i), isComment: true, isSemicolon: false };
  }
  if (ch === "'" || ch === '"') {
    return { end: skipQuoted(sql, i), isComment: false, isSemicolon: false };
  }
  if (ch === '$') {
    const end = skipDollarQuoted(sql, i);
    if (end !== -1) return { end, isComment: false, isSemicolon: false };
  }
  return { end: i + 1, isComment: false, isSemicolon: ch === ';' };
}

/**
 * Splits a PostgreSQL script into statements on top-level semicolons, respecting strings,
 * quoted identifiers, dollar-quoted bodies and comments. Blank (whitespace/comment-only)
 * pieces are dropped. Offsets exclude surrounding whitespace and the trailing semicolon.
 * @param sql - the script
 * @returns statements in source order
 */
export function splitSql(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let pieceStart = 0;
  let i = 0;
  const pushPiece = (end: number) => {
    const raw = sql.slice(pieceStart, end);
    if (!isBlankSql(raw)) {
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      statements.push({ text, start: pieceStart + lead, end: pieceStart + lead + text.length });
    }
  };
  while (i < sql.length) {
    const token = scanToken(sql, i);
    if (token.isSemicolon) {
      pushPiece(i);
      pieceStart = token.end;
    }
    i = token.end;
  }
  pushPiece(sql.length);
  return statements;
}

/**
 * Picks the statement a cursor belongs to. A cursor sitting in the gap after a statement
 * (on its semicolon or trailing whitespace) belongs to that preceding statement.
 * @param sql - the script
 * @param offset - cursor offset into the script
 * @returns the statement, or undefined when the script is blank
 */
export function statementAt(sql: string, offset: number): SqlStatement | undefined {
  const statements = splitSql(sql);
  let candidate: SqlStatement | undefined;
  for (const statement of statements) {
    if (statement.start <= offset) candidate = statement;
    else break;
  }
  return candidate ?? statements[0];
}
