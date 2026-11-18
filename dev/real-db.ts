import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Runs a throwaway real PostgreSQL (embedded-postgres binaries) for the Rust integration tests,
 * which cover behavior the PGlite sample cannot show: per-connection sessions, cancellation and
 * authentication errors. Prints DATAGRABBER_TEST_PG=<port> once ready; Ctrl+C removes the data.
 */
const PORT = Number(process.env.REAL_DB_PORT ?? 54330);
export const PASSWORD = 'it-password';

const dataDir = await mkdtemp(join(tmpdir(), 'datagrabber-pg-'));
const server = new EmbeddedPostgres({ databaseDir: dataDir, port: PORT, user: 'postgres', password: PASSWORD, persistent: false, onLog: () => undefined, onError: () => undefined });
await server.initialise();
await server.start();
console.log(`DATAGRABBER_TEST_PG=${PORT} (user postgres, password ${PASSWORD})`);

/** Stops the server and deletes its data directory. */
async function shutdown(): Promise<void> {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
