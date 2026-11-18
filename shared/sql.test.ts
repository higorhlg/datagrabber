import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSql, statementAt, isBlankSql } from './sql-split.ts';
import { findTableReferences, resolveQualifier } from './sql-context.ts';

const texts = (sql: string) => splitSql(sql).map((s) => s.text);

test('splits on top-level semicolons and drops blanks', () => {
  assert.deepEqual(texts('select 1; select 2;\n\n;  -- trailing\n'), ['select 1', 'select 2']);
});

test('ignores semicolons inside strings, identifiers and comments', () => {
  const sql = `select ';' as "a;b"; -- c;d\nselect 'it''s; fine' /* x; /* nested; */ y */;select E'\\';'`;
  assert.deepEqual(texts(sql), [`select ';' as "a;b"`, `-- c;d\nselect 'it''s; fine' /* x; /* nested; */ y */`, `select E'\\';'`]);
});

test('ignores semicolons inside dollar-quoted bodies but not $1 params', () => {
  const sql = `create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql; select $1;select $$a;b$$`;
  assert.deepEqual(texts(sql), [
    `create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql`,
    'select $1',
    'select $$a;b$$',
  ]);
});

test('offsets point at the statement text', () => {
  const sql = '  select 1 ;\nselect 2';
  for (const s of splitSql(sql)) assert.equal(sql.slice(s.start, s.end), s.text);
});

test('statementAt picks the statement around or before the cursor', () => {
  const sql = 'select 1;\n\nselect 2;';
  assert.equal(statementAt(sql, 3)?.text, 'select 1');
  assert.equal(statementAt(sql, 9)?.text, 'select 1');
  assert.equal(statementAt(sql, 13)?.text, 'select 2');
  assert.equal(statementAt('   ', 1), undefined);
});

test('isBlankSql treats comment-only text as blank', () => {
  assert.equal(isBlankSql(' -- hi\n/* there */ '), true);
  assert.equal(isBlankSql('select 1'), false);
});

test('findTableReferences resolves aliases across joins and comma lists', () => {
  const refs = findTableReferences(
    'select o.id from shop.orders o join "Customers" as c on c.id = o.customer_id, products p left join x on true where 1=1',
  );
  assert.deepEqual(refs, [
    { schema: 'shop', table: 'orders', alias: 'o' },
    { table: 'Customers', alias: 'c' },
    { table: 'x' },
    { table: 'products', alias: 'p' },
  ]);
});

test('findTableReferences does not treat keywords as aliases', () => {
  assert.deepEqual(findTableReferences('select * from a join b on true where x in (1, 2)'), [{ table: 'a' }, { table: 'b' }]);
  assert.deepEqual(findTableReferences('update t set x = 1'), [{ table: 't' }]);
  assert.deepEqual(findTableReferences('select * from a join b on f(a.x, b.y) = 1, c'), [{ table: 'a' }, { table: 'b' }, { table: 'c' }]);
  assert.deepEqual(findTableReferences('select * from (select * from a, b) s where z in (1, 2)'), [{ table: 'a' }, { table: 'b' }]);
});

test('resolveQualifier prefers aliases, then table names', () => {
  const refs = findTableReferences('select * from orders o, customers');
  assert.equal(resolveQualifier(refs, 'o')?.table, 'orders');
  assert.equal(resolveQualifier(refs, 'customers')?.table, 'customers');
  assert.equal(resolveQualifier(refs, 'zzz'), undefined);
});
