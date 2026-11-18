import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/**
 * Runs the UI self-test (web/src/selftest.ts) inside the real desktop app.
 *
 *   pnpm e2e --scenario sample [--home <dir>] [--screenshot out.png]
 *   pnpm e2e --scenario import [--expected 8] [--add-sample]
 *   pnpm e2e --scenario passwords --home <dir>   (fake DataGrip project + fake DataGrip Keychain items)
 *
 * Builds a debug app (frontend embedded), starts the PGlite sample DB if it isn't running,
 * launches the app with DATAGRABBER_E2E set and exits with the self-test's status.
 * Passwords stay in memory during the run (DATAGRABBER_SECRETS=memory).
 */
const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'sample' },
    home: { type: 'string' },
    screenshot: { type: 'string' },
    expected: { type: 'string' },
    'add-sample': { type: 'boolean', default: false },
    'sample-port': { type: 'string', default: '54329' },
    'skip-build': { type: 'boolean', default: false },
  },
});

const root = join(import.meta.dirname, '..');
const binary = join(root, 'src-tauri', 'target', 'debug', 'datagrabber');
const samplePort = Number(values['sample-port']);

/** Resolves true when something accepts TCP connections on the port. */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => (socket.end(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

/** Builds the debug app with the frontend embedded (no dev server needed). */
function buildApp(): void {
  const result = spawnSync('pnpm', ['tauri', 'build', '--debug', '--no-bundle'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('tauri build failed');
}

/** Starts the sample DB in the background unless one is already listening. */
async function ensureSampleDb(): Promise<void> {
  if (await isListening(samplePort)) return;
  const child = spawn('node', ['dev/sample-db.ts'], { cwd: root, env: { ...process.env, SAMPLE_DB_PORT: String(samplePort) }, stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 100 && !(await isListening(samplePort)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await isListening(samplePort))) throw new Error('sample DB did not start');
}

/** Finds the app window's CoreGraphics id (for screencapture -l) via a tiny Swift script. */
function windowId(pid: number): string | undefined {
  const script = `import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w["kCGWindowOwnerPID"] as? Int) == ${pid} && (w["kCGWindowLayer"] as? Int) == 0 { print(w["kCGWindowNumber"]!); break }`;
  const result = spawnSync('swift', ['-e', script], { encoding: 'utf8' });
  return result.stdout.trim() || undefined;
}

if (!values['skip-build']) buildApp();
await ensureSampleDb();

const config = {
  scenario: values.scenario,
  samplePort,
  expectedImports: values.expected ? Number(values.expected) : undefined,
  addSample: values['add-sample'],
  holdMs: values.screenshot ? 2500 : 300,
};
/**
 * Writes a fake DataGrip project with two data sources pointing at the sample DB, and returns the
 * fake DataGrip Keychain items (only the first source has a saved password).
 */
function fakeDatagripProject(dir: string): [string, string, string][] {
  mkdirSync(dir, { recursive: true });
  const source = (uuid: string, name: string) =>
    `<data-source source="LOCAL" name="${name}" uuid="${uuid}"><driver-ref>postgresql</driver-ref><jdbc-url>jdbc:postgresql://127.0.0.1:${samplePort}/postgres</jdbc-url></data-source>`;
  writeFileSync(join(dir, 'dataSources.xml'), `<project version="4"><component name="DataSourceManagerImpl">${source('e2e-dev', 'Fake shop dev')}${source('e2e-prod', 'Fake shop prod')}</component></project>`);
  writeFileSync(
    join(dir, 'dataSources.local.xml'),
    `<project version="4"><component name="dataSourceStorageLocal"><data-source name="Fake shop dev" uuid="e2e-dev"><user-name>postgres</user-name></data-source><data-source name="Fake shop prod" uuid="e2e-prod"><user-name>postgres</user-name></data-source></component></project>`,
  );
  return [['IntelliJ Platform DB \u2014 e2e-dev', 'postgres', 'fake-password']];
}

const env: NodeJS.ProcessEnv = { ...process.env, DATAGRABBER_E2E: '', DATAGRABBER_SECRETS: 'memory' };
if (values.scenario === 'passwords') {
  if (!values.home) throw new Error('--scenario passwords needs --home');
  const datagripDir = join(values.home, 'fake-datagrip');
  env.DATAGRABBER_TEST_EXTERNAL_SECRETS = JSON.stringify(fakeDatagripProject(datagripDir));
  Object.assign(config, { datagripDir });
}
env.DATAGRABBER_E2E = JSON.stringify(config);
if (values.home) env.DATAGRABBER_HOME = values.home;

const app = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'inherit'] });
let output = '';
app.stdout.on('data', (chunk: Buffer) => {
  output += chunk;
  process.stdout.write(chunk);
});

const timeout = setTimeout(() => {
  console.error('[e2e] timed out after 120s');
  app.kill();
}, 120_000);

if (values.screenshot) {
  const shoot = async () => {
    for (let i = 0; i < 600; i++) {
      if (output.includes('[e2e] ready-for-screenshot')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const id = app.pid ? windowId(app.pid) : undefined;
    const args = id ? ['-x', '-o', `-l${id}`, values.screenshot!] : ['-x', values.screenshot!];
    const shot = spawnSync('screencapture', args, { encoding: 'utf8' });
    console.log(shot.status === 0 ? `[e2e] screenshot saved to ${values.screenshot}` : `[e2e] screenshot failed: ${shot.stderr}`);
  };
  shoot();
}

app.on('exit', (code) => {
  clearTimeout(timeout);
  process.exit(code ?? 1);
});
