import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/**
 * Runs the in-app self-test (web/src/testing/selftest.ts) inside the real desktop app.
 *
 *   pnpm e2e --scenario sample [--home <dir>] [--screenshot out.png]
 *   pnpm e2e --scenario import [--expected 8] [--add-sample]
 *   pnpm e2e --scenario passwords --home <dir>   fake DataGrip project + fake DataGrip Keychain items
 *   pnpm e2e --scenario loading --home <dir>     loading states and Stop (needs `pnpm real-db`)
 *
 * Builds a debug app (frontend embedded), starts the PGlite sample DB if it isn't running,
 * launches the app with DATAGRABBER_E2E set and exits with the self-test's status. Passwords stay
 * in memory (DATAGRABBER_SECRETS=memory). Screenshots (--screenshot, snap()) capture only the app window.
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
const REAL_DB = { port: 54330, password: 'it-password' };

/** Resolves true when something accepts TCP connections on the port. */
function isListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.end();
      done(true);
    });
    socket.once('error', () => done(false));
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
  const child = spawn('node', ['dev/sample-db.ts'], {
    cwd: root,
    env: { ...process.env, SAMPLE_DB_PORT: String(samplePort) },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 100 && !(await isListening(samplePort)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await isListening(samplePort))) throw new Error('sample DB did not start');
}

type WindowInfo = { id: string; x: number; y: number; width: number; height: number };

/** Finds the app's main window (CoreGraphics id and bounds in points) via a tiny Swift script. */
function findWindow(pid: number): WindowInfo | undefined {
  const script = `import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w["kCGWindowOwnerPID"] as? Int) == ${pid} && (w["kCGWindowLayer"] as? Int) == 0 {
  let b = w["kCGWindowBounds"] as! [String: Any]
  print(w["kCGWindowNumber"]!, b["X"]!, b["Y"]!, b["Width"]!, b["Height"]!); break
}`;
  const [id, x, y, width, height] = spawnSync('swift', ['-e', script], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
  return id ? { id, x: Number(x), y: Number(y), width: Number(width), height: Number(height) } : undefined;
}

/**
 * Writes a fake DataGrip project with two data sources pointing at the sample DB, and returns the
 * fake DataGrip Keychain items (only the first source has a saved password).
 */
function fakeDatagripProject(dir: string): [string, string, string][] {
  mkdirSync(dir, { recursive: true });
  const source = (uuid: string, name: string) =>
    `<data-source source="LOCAL" name="${name}" uuid="${uuid}"><driver-ref>postgresql</driver-ref><jdbc-url>jdbc:postgresql://127.0.0.1:${samplePort}/postgres</jdbc-url></data-source>`;
  writeFileSync(
    join(dir, 'dataSources.xml'),
    `<project version="4"><component name="DataSourceManagerImpl">${source('e2e-dev', 'Fake shop dev')}${source('e2e-prod', 'Fake shop prod')}</component></project>`,
  );
  writeFileSync(
    join(dir, 'dataSources.local.xml'),
    `<project version="4"><component name="dataSourceStorageLocal"><data-source name="Fake shop dev" uuid="e2e-dev"><user-name>postgres</user-name></data-source><data-source name="Fake shop prod" uuid="e2e-prod"><user-name>postgres</user-name></data-source></component></project>`,
  );
  return [['IntelliJ Platform DB — e2e-dev', 'postgres', 'fake-password']];
}

if (!values['skip-build']) buildApp();
await ensureSampleDb();

const config: Record<string, unknown> = {
  scenario: values.scenario,
  samplePort,
  expectedImports: values.expected ? Number(values.expected) : undefined,
  addSample: values['add-sample'],
  holdMs: values.screenshot ? 2500 : 300,
};
const env: NodeJS.ProcessEnv = { ...process.env, DATAGRABBER_SECRETS: 'memory' };

const needsRealDb = values.scenario === 'loading';
if (needsRealDb) {
  if (!(await isListening(REAL_DB.port))) throw new Error(`this scenario needs \`pnpm real-db\` running on :${REAL_DB.port}`);
  Object.assign(config, { realPort: REAL_DB.port, realPassword: REAL_DB.password });
}
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

/** Screenshots requested mid-test with snap(label) land next to --screenshot as <name>-<label>.png. */
function captureSnapshot(label: string): void {
  if (!values.screenshot) return;
  const window = app.pid ? findWindow(app.pid) : undefined;
  const file = values.screenshot.replace(/\.png$/, `-${label}.png`);
  spawnSync('screencapture', window ? ['-x', '-o', `-l${window.id}`, file] : ['-x', file]);
  console.log(`[e2e] snapshot saved to ${file}`);
}

app.stdout?.on('data', (chunk: Buffer) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  for (const [, label] of text.matchAll(/\[e2e\] snap:([\w-]+)/g)) captureSnapshot(label);
});

const timeout = setTimeout(() => {
  console.error('[e2e] timed out after 180s');
  app.kill();
}, 180_000);

if (values.screenshot) {
  (async () => {
    for (let i = 0; i < 1200 && !output.includes('[e2e] ready-for-screenshot'); i++) await new Promise((r) => setTimeout(r, 100));
    const window = app.pid ? findWindow(app.pid) : undefined;
    const shot = spawnSync('screencapture', window ? ['-x', '-o', `-l${window.id}`, values.screenshot!] : ['-x', values.screenshot!], {
      encoding: 'utf8',
    });
    console.log(shot.status === 0 ? `[e2e] screenshot saved to ${values.screenshot}` : `[e2e] screenshot failed: ${shot.stderr}`);
  })();
}

app.on('exit', async (code) => {
  clearTimeout(timeout);
  process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.kill();
    process.exit(130);
  });
}
process.on('uncaughtException', (error) => {
  app.kill();
  console.error(error);
  process.exit(1);
});
