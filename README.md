# Datagrabber

A personal PostgreSQL desktop client (Tauri: Rust backend, React + Monaco UI).

- **Connections** saved in `~/.datagrabber/connections.json`, passwords in the macOS Keychain
  (service `datagrabber`), colored by environment, optional **read-only** mode
  (`set session characteristics as transaction read only` on every connection the app opens).
- **Import from DataGrip** (`~/DataGripProjects/.idea` by default): host, port, database and user.
  DataGrip keeps passwords in its own encrypted store, so each connection asks once on first connect.
  Names containing "prod" start read-only. Re-importing updates connections instead of duplicating them.
- **Console per connection** (persisted in `~/.datagrabber/consoles/`): ⌘↵ runs the statement at the
  cursor or the selection, ⇧⌘↵ runs everything, Cancel sends a real `pg_cancel` to the server.
  Errors are marked in the editor at the position PostgreSQL reports.
- **Autocomplete** for schemas, tables and columns, including through aliases (`o.` after `from orders o`).
- **Results grid**: virtualized, sortable, filterable, NULL-aware, value viewer (pretty JSON),
  copy as TSV/CSV/JSON/INSERT, save CSV/JSON to Downloads. Row cap per run (default 500): queries
  go through a server-side cursor, so `select * from huge_table` stops at the cap. Inside a
  transaction you opened yourself the cursor joins it; it never commits on your behalf.
- **Database Explorer** (DataGrip-style): connection → database → schema → tables. Views, materialized
  views, sequences and routines are hidden behind a "N views · … hidden — show" line (or the 👁 toolbar
  toggle). Expanding a table shows columns, keys, foreign keys and indexes; **Properties…** (right-click
  or ⓘ) explains what an object is.
- **Table tabs**: click a table to open `name [connection]` with WHERE / ORDER BY bars, header-click
  sorting, paging, "count all", copy/export and a DDL view. Table tabs and the explorer use their own
  connection with `lock_timeout = 5s` and `statement_timeout = 30s`, so opening a table never hangs
  behind a migration's lock or runs for minutes; consoles have no time limit and can be cancelled.
- **History and saved queries per database** (`history.json`, `saved_queries.json`): every run is
  listed in the console's History panel; ★ saves a query under a name, and saved queries run with one click.

## Run

```sh
pnpm install
pnpm app                   # dev mode (hot reload)
pnpm build                 # release bundle → src-tauri/target/release/bundle/macos/Datagrabber.app
```

## Try it on fake data

```sh
pnpm sample-db             # in-memory PostgreSQL (PGlite) on 127.0.0.1:54329, any user/password
```

Then open **Sample shop (PGlite)** in the sidebar (user `postgres`, any password). PGlite runs every
connection through one backend, so session settings such as read-only leak between connections there;
real PostgreSQL does not have that limitation.

## Tests

```sh
pnpm real-db               # real PostgreSQL (embedded binaries) on :54330, in another terminal
pnpm test                  # SQL splitter/alias tests + Rust unit and integration tests
                           # (integration tests need DATAGRABBER_TEST_PG=54330 in the environment)
pnpm e2e --scenario sample --home /tmp/dg-e2e    # drives the real app window against the sample DB
```

`pnpm e2e` builds a debug app and runs `web/src/selftest.ts` inside it (clicks, typing, editor
commands); `--screenshot out.png` captures the window. Use `--home` to keep test data out of
`~/.datagrabber`.

## Layout

| Path | What |
| --- | --- |
| `src-tauri/src/` | Rust backend: sessions/TLS (`session.rs`), statement execution (`query.rs`), introspection, DataGrip import, keychain, storage, Tauri commands |
| `web/src/` | UI: sidebar/schema tree, consoles (Monaco), results grid, dialogs, self-test |
| `shared/` | Types shared with the UI, SQL statement splitter and alias resolution (with tests) |
| `dev/` | Sample DB (PGlite), real Postgres for tests, e2e runner |
