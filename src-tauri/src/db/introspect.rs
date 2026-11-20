//! Reads the database structure for the explorer tree from pg_catalog: schemas, relations
//! (tables, views, materialized views, partitioned and foreign tables; individual partitions
//! excluded) with columns, indexes and foreign keys, sequences, routines (functions installed by
//! extensions excluded), plus the search_path.

use std::collections::HashMap;

use super::session::{Session, describe_pg_error};
use crate::error::{CommandError, CommandResult};
use crate::model::{ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, RelationInfo, RoutineInfo, SchemaInfo};

const HIDDEN_SCHEMAS: &str =
    "n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp\\_%'";

fn schemas_sql() -> String {
    format!("select n.nspname::text from pg_namespace n where {HIDDEN_SCHEMAS} order by 1")
}

fn columns_sql() -> String {
    format!(
        "select n.nspname::text, c.relname::text, c.relkind::text,
                case when c.reltuples < 0 then null else c.reltuples::int8 end,
                a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid),
                coalesce(a.attnum = any(pk.indkey), false)
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
         left join pg_index pk on pk.indrelid = c.oid and pk.indisprimary
         where c.relkind in ('r', 'v', 'm', 'p', 'f') and not c.relispartition and {HIDDEN_SCHEMAS}
         order by n.nspname, c.relname, a.attnum"
    )
}

fn indexes_sql() -> String {
    format!(
        "select n.nspname::text, c.relname::text, ic.relname::text, i.indisunique, i.indisprimary, pg_get_indexdef(i.indexrelid)
         from pg_index i
         join pg_class c on c.oid = i.indrelid
         join pg_class ic on ic.oid = i.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
         where {HIDDEN_SCHEMAS}
         order by 1, 2, i.indisprimary desc, 3"
    )
}

fn foreign_keys_sql() -> String {
    format!(
        "select n.nspname::text, c.relname::text, con.conname::text, pg_get_constraintdef(con.oid, true)
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         where con.contype = 'f' and {HIDDEN_SCHEMAS}
         order by 1, 2, 3"
    )
}

fn sequences_sql() -> String {
    format!(
        "select n.nspname::text, c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'S' and {HIDDEN_SCHEMAS} order by 1, 2"
    )
}

fn routines_sql() -> String {
    format!(
        "select n.nspname::text, p.proname::text, pg_get_function_identity_arguments(p.oid), (to_jsonb(p) ->> 'prokind')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where {HIDDEN_SCHEMAS}
           and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
         order by 1, 2, 3"
    )
}

fn relation_kind(code: &str) -> &'static str {
    match code {
        "v" => "view",
        "m" => "materialized view",
        "p" => "partitioned table",
        "f" => "foreign table",
        _ => "table",
    }
}

fn routine_kind(code: Option<&str>) -> &'static str {
    match code {
        Some("p") => "procedure",
        Some("a") => "aggregate",
        Some("w") => "window",
        _ => "function",
    }
}

/// Returns the index of the named schema, appending it when the schema query missed it.
fn schema_index(schemas: &mut Vec<SchemaInfo>, name: String) -> usize {
    if let Some(index) = schemas.iter().position(|s| s.name == name) {
        return index;
    }
    schemas.push(SchemaInfo { name, relations: Vec::new(), sequences: Vec::new(), routines: Vec::new() });
    schemas.len() - 1
}

/// Groups one-row-per-column results into relations under their schemas.
fn add_relations(schemas: &mut Vec<SchemaInfo>, rows: &[tokio_postgres::Row]) {
    for row in rows {
        let index = schema_index(schemas, row.get(0));
        let relation_name: String = row.get(1);
        let relations = &mut schemas[index].relations;
        if relations.last().is_none_or(|r| r.name != relation_name) {
            relations.push(RelationInfo {
                name: relation_name,
                kind: relation_kind(row.get::<_, &str>(2)),
                estimated_rows: row.get(3),
                columns: Vec::new(),
                indexes: Vec::new(),
                foreign_keys: Vec::new(),
            });
        }
        if let Some(column_name) = row.get::<_, Option<String>>(4) {
            relations.last_mut().expect("relation pushed above").columns.push(ColumnInfo {
                name: column_name,
                type_name: row.get::<_, Option<String>>(5).unwrap_or_default(),
                not_null: row.get::<_, Option<bool>>(6).unwrap_or(false),
                default: row.get(7),
                primary_key: row.get(8),
            });
        }
    }
}

/// Maps (schema, relation) to positions in the schema list for attaching indexes and keys.
fn relation_positions(schemas: &[SchemaInfo]) -> HashMap<(String, String), (usize, usize)> {
    let mut positions = HashMap::new();
    for (s, schema) in schemas.iter().enumerate() {
        for (r, relation) in schema.relations.iter().enumerate() {
            positions.insert((schema.name.clone(), relation.name.clone()), (s, r));
        }
    }
    positions
}

/// Introspects the database on the session's meta connection.
pub async fn introspect(session: &Session) -> CommandResult<DatabaseSchema> {
    let pg_error = |e: tokio_postgres::Error| CommandError::new(describe_pg_error(&e));
    let queries = [schemas_sql(), columns_sql(), indexes_sql(), foreign_keys_sql(), sequences_sql(), routines_sql()];
    let meta = &session.meta;
    let (schema_rows, column_rows, index_rows, fk_rows, sequence_rows, routine_rows, path_rows) = tokio::try_join!(
        meta.query(&queries[0], &[]),
        meta.query(&queries[1], &[]),
        meta.query(&queries[2], &[]),
        meta.query(&queries[3], &[]),
        meta.query(&queries[4], &[]),
        meta.query(&queries[5], &[]),
        meta.query("select current_schemas(false)::text[]", &[]),
    )
    .map_err(pg_error)?;

    let mut schemas: Vec<SchemaInfo> = schema_rows
        .iter()
        .map(|r| SchemaInfo { name: r.get(0), relations: Vec::new(), sequences: Vec::new(), routines: Vec::new() })
        .collect();
    add_relations(&mut schemas, &column_rows);
    let positions = relation_positions(&schemas);
    for row in &index_rows {
        if let Some(&(s, r)) = positions.get(&(row.get(0), row.get(1))) {
            schemas[s].relations[r].indexes.push(IndexInfo {
                name: row.get(2),
                unique: row.get(3),
                primary: row.get(4),
                definition: row.get(5),
            });
        }
    }
    for row in &fk_rows {
        if let Some(&(s, r)) = positions.get(&(row.get(0), row.get(1))) {
            schemas[s].relations[r].foreign_keys.push(ForeignKeyInfo { name: row.get(2), definition: row.get(3) });
        }
    }
    for row in &sequence_rows {
        let index = schema_index(&mut schemas, row.get(0));
        schemas[index].sequences.push(row.get(1));
    }
    for row in &routine_rows {
        let index = schema_index(&mut schemas, row.get(0));
        schemas[index].routines.push(RoutineInfo {
            name: row.get(1),
            arguments: row.get(2),
            kind: routine_kind(row.get::<_, Option<&str>>(3)),
        });
    }
    let search_path: Vec<String> = path_rows.first().map(|r| r.get(0)).unwrap_or_else(|| vec!["public".to_string()]);
    Ok(DatabaseSchema { schemas, search_path })
}
