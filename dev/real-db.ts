import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Runs a throwaway real PostgreSQL (embedded-postgres binaries) for the Rust integration tests,
 * which cover behavior the PGlite sample cannot show: per-connection sessions, cancellation and
 * authentication errors. Also seeds an `events` table and a slow report view for trying loading
 * states and Stop by hand. Prints
 * DATAGRABBER_TEST_PG=<port> once ready; Ctrl+C removes the data.
 */
const PORT = Number(process.env.REAL_DB_PORT ?? 54330);
export const PASSWORD = 'it-password';

const dataDir = await mkdtemp(join(tmpdir(), 'datagrabber-pg-'));
const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  port: PORT,
  user: 'postgres',
  password: PASSWORD,
  persistent: false,
  // pnpm skips dependency install scripts, which create the Linux binaries' library symlinks.
  autoRehydrateSymlinks: true,
  onLog: () => undefined,
  onError: () => undefined,
});
await server.initialise();
await server.start();
await seedDemoData();
console.log(`DATAGRABBER_TEST_PG=${PORT} (user postgres, password ${PASSWORD})`);

/**
 * Sample data: an `events` table (300k rows) and a deliberately slow report view (it sleeps per
 * output row), handy for seeing loading states and the Stop button against a real server.
 */
async function seedDemoData(): Promise<void> {
  const client = server.getPgClient();
  await client.connect();
  await client.query(`
    create table events as
      select g as id, now() - (g || ' minutes')::interval as occurred_at,
             (array['signup', 'login', 'purchase', 'refund'])[1 + g % 4] as kind,
             1 + g % 5000 as user_id, jsonb_build_object('sku', 'SKU-' || (g % 300), 'amount', round((g % 97) * 1.75, 2)) as payload
      from generate_series(1, 300000) g;
    alter table events add primary key (id);
    create index events_kind_idx on events (kind);
    create view slow_daily_report as
      select day, events, purchases
      from (select date_trunc('day', occurred_at) as day, count(*) as events, count(*) filter (where kind = 'purchase') as purchases
            from events group by 1) daily
      where pg_sleep(0.3) is not null
      order by day desc;
    analyze events;
  `);
  await client.end();
}

/** Stops the server and deletes its data directory. */
async function shutdown(): Promise<void> {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
