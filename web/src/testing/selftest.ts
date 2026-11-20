import { api } from '../lib/api.ts';
import { monaco } from '../lib/monaco/setup.ts';
import {
  all,
  byText,
  expectSeen,
  field,
  pageRange,
  sleep,
  status,
  treeRow,
  typeInto,
  visibleAll,
  visibleCells,
  visibleEditor,
  waitFor,
  watchAppearances,
} from './dom.ts';

/**
 * End-to-end self-test that drives the real UI inside the Tauri window (clicks, typing, editor
 * commands) against real backends. It only runs when the app is started with DATAGRABBER_E2E
 * (see dev/e2e.ts), and reports PASS/FAIL to the process, which then exits.
 *
 * Scenarios:
 * - "sample": create a connection to the PGlite sample DB through the form, browse the explorer
 *   (tables only, views revealed on demand), open table tabs (paging, filter, sort, count, DDL,
 *   Properties), run statements in a console (autocomplete, errors, value viewer), and save a
 *   query from history and rerun it.
 * - "import": import every DataGrip data source through the import dialog, check prod ones are
 *   read-only, and check a connection asks for its password without contacting the server.
 */
export type SelfTestConfig = {
  scenario: 'sample' | 'import' | 'passwords' | 'loading';
  realPort?: number;
  realPassword?: string;
  samplePort?: number;
  expectedImports?: number;
  holdMs?: number;
  addSample?: boolean;
  datagripDir?: string;
};

const SAMPLE_NAME = 'Sample shop (PGlite)';
const log: string[] = [];
/** Asks the runner to screenshot the window now (with --screenshot), pausing so the capture lands. */
async function snap(label: string): Promise<void> {
  await api.e2eLog(`snap:${label}`);
  await sleep(1500);
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
  const started = performance.now();
  await body();
  log.push(`ok   ${name} (${Math.round(performance.now() - started)} ms)`);
}

/** Runs the sample-database scenario. */
async function sampleScenario(config: SelfTestConfig): Promise<void> {
  const name = SAMPLE_NAME;
  await step('create a connection through the form and test it', async () => {
    document.querySelector<HTMLButtonElement>('button[title="New connection"]')!.click();
    await waitFor('connection form', () => document.querySelector('#connection-form'));
    typeInto(field('Name'), name);
    typeInto(field('Host'), '127.0.0.1');
    typeInto(field('Port'), String(config.samplePort ?? 54329));
    typeInto(field('Database'), 'postgres');
    typeInto(field('User'), 'postgres');
    typeInto(field('Password'), 'sample');
    byText('button', 'Test connection')!.click();
    await waitFor('successful connection test', () => byText('.status', /Connected — PostgreSQL/));
    byText('button', 'Save')!.click();
    await waitFor('connection in explorer', () => treeRow(name));
  });

  await step('connect from the explorer: tables only, views hidden behind a hint', async () => {
    treeRow(name)!.click();
    await waitFor('table customers in tree', () => treeRow('customers'), 15_000);
    for (const table of ['orders', 'order_items', 'products', 'daily_revenue', 'app_settings'])
      if (!treeRow(table)) throw new Error(`missing table ${table}`);
    if (treeRow('order_totals')) throw new Error('views should be hidden by default');
    const hint = await waitFor('hidden kinds hint', () => byText('.hidden-kinds', /1 view · 3 sequences hidden/));
    log.push(`     hint: ${hint.textContent}`);
  });

  await step('click a table to open it in a tab (paging, filter, header sort, count)', async () => {
    treeRow('orders')!.click();
    await waitFor('orders tab', () => byText('.editor-tab .tab-label', `orders [${name}]`));
    await waitFor('first page', () => pageRange() === '1–500' && pageRange());
    document.querySelector<HTMLButtonElement>('[data-testid=next-page]')!.click();
    await waitFor('second page', () => pageRange() === '501–1,000');
    const filter = document.querySelector<HTMLInputElement>('[data-testid=filter-input]')!;
    typeInto(filter, "status = 'refunded'");
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(
      'filtered page',
      () => pageRange().startsWith('1–') && visibleCells('status').every((v) => v === 'refunded') && visibleCells('status').length > 0,
    );
    byText('.grid-head-cell .col-name', 'id')!.closest('button')!.click();
    await waitFor('ORDER BY from header', () => document.querySelector<HTMLInputElement>('[data-testid=order-input]')!.value === 'id asc');
    byText('.grid-head-cell .col-name', 'id')!.closest('button')!.click();
    await waitFor('descending', () => document.querySelector<HTMLInputElement>('[data-testid=order-input]')!.value === 'id desc');
    await waitFor('rows sorted desc', () => {
      const ids = visibleCells('id').map(Number);
      return ids.length > 1 && ids[0] > ids[1];
    });
    byText('.row-pill button', 'count all')!.click();
    const total = await waitFor('total count', () => document.querySelector('[data-testid=total-count]'));
    log.push(`     refunded orders: ${total.textContent}, breadcrumb: ${document.querySelector('[data-testid=breadcrumb]')!.textContent}`);
  });

  await step('DDL of the open table', async () => {
    document.querySelector<HTMLButtonElement>('[data-testid=ddl-tab]')!.click();
    await waitFor('DDL text', () => monaco.editor.getModels().some((m) => m.getValue().startsWith('create table shop.orders')));
  });

  await step('reveal views and open Properties from the context menu', async () => {
    byText('.hidden-kinds', /hidden/)!.click();
    await waitFor('view in tree', () => treeRow('order_totals'));
    treeRow('order_totals')!
      .closest('.tree-row')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }));
    (await waitFor('context menu', () => byText('.context-menu button', 'Properties…'))).click();
    const props = await waitFor('properties dialog', () => document.querySelector('[data-testid=properties]'));
    if (!/view/.test(props.querySelector('.kind-label')?.textContent ?? '')) throw new Error('properties should say view');
    (await waitFor('open view button', () => byText('.modal-foot button', 'Open view'))).click();
    await waitFor('view tab', () => byText('.editor-tab .tab-label', `order_totals [${name}]`));
    await waitFor('view rows', () => /^1–/.test(pageRange()));
    document.querySelector<HTMLButtonElement>('[data-testid=toggle-all-kinds]')!.click();
  });

  await step('open the query console (double-click the connection)', async () => {
    treeRow(name)!
      .closest('.tree-row')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor('console editor', () => visibleEditor());
  });
  await step('run the statement under the cursor (⌘↵ path)', async () => {
    const editor = visibleEditor()!;
    editor.setValue("select 1 as one;\n\nselect id, email, country from shop.customers\nwhere country = 'BR'\norder by id;\n");
    editor.setPosition({ lineNumber: 3, column: 5 });
    editor.trigger('selftest', 'datagrabber.run', {});
    await waitFor('rows from customers', () => /^\d+ rows/.test(status()) && status());
    const header = visibleAll('.grid-head-cell .col-name').map((h) => h.textContent);
    if (header.join(',') !== 'id,email,country') throw new Error(`unexpected columns ${header.join(',')}`);
    log.push(`     result: ${status()}`);
  });

  await step('run all statements; stop and mark the failing one', async () => {
    const editor = visibleEditor()!;
    editor.setValue('select count(*) from shop.orders;\nselect nope from shop.orders;\nselect 3;\n');
    document.querySelector<HTMLButtonElement>('[data-testid=run-all]')!.click();
    const error = await waitFor('error panel', () => visibleAll('[data-testid=query-error]')[0]);
    if (!/column "nope" does not exist/.test(error.textContent ?? '')) throw new Error(`unexpected error ${error.textContent}`);
    const markers = monaco.editor.getModelMarkers({ resource: editor.getModel()!.uri });
    if (markers.length !== 1 || markers[0].startLineNumber !== 2)
      throw new Error(`expected an error marker on line 2, got ${JSON.stringify(markers)}`);
    if (all('.results-tab').length !== 2) throw new Error('third statement should not have run');
  });

  await step('autocomplete columns through a table alias', async () => {
    const editor = visibleEditor()!;
    editor.setValue('select o. from shop.orders o');
    editor.setPosition({ lineNumber: 1, column: 10 });
    editor.focus();
    editor.trigger('selftest', 'editor.action.triggerSuggest', {});
    const suggestion = await waitFor('customer_id suggestion', () =>
      all('.suggest-widget .monaco-list-row').find((r) => r.getAttribute('aria-label')?.includes('customer_id')),
    );
    log.push(
      `     suggested: ${all('.suggest-widget .monaco-list-row')
        .map((r) => r.getAttribute('aria-label')?.split(',')[0])
        .join(', ')}`,
    );
    editor.trigger('selftest', 'hideSuggestWidget', {});
    void suggestion;
  });

  await step('JSON/array values and the value viewer', async () => {
    const editor = visibleEditor()!;
    editor.setValue('select sku, tags, attributes from shop.products order by id limit 5');
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.trigger('selftest', 'datagrabber.run', {});
    await waitFor('products rows', () => status().startsWith('5 rows'));
    const cell = visibleAll('.grid-row')
      .map((r) => r.querySelectorAll('.grid-cell')[2])
      .find(Boolean)!;
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const viewer = await waitFor('value viewer', () => document.querySelector('.value-viewer'));
    if (!viewer.textContent?.includes('"weight_g"')) throw new Error('JSON should be pretty-printed');
    byText('.modal-foot button', 'Close')!.click();
  });

  await step('history is listed per database; star a query and rerun it from Saved', async () => {
    await waitFor('history entries', () => all('[data-testid=history-item]').length >= 4 && all('[data-testid=history-item]'));
    if (!all('.library-item.failed').length) throw new Error('failed statement missing from history');
    const editor = visibleEditor()!;
    editor.setValue("select id, email from shop.customers where country = 'BR' order by id limit 3");
    editor.setPosition({ lineNumber: 1, column: 3 });
    document.querySelector<HTMLButtonElement>('[data-testid=save-query]')!.click();
    const nameInput = await waitFor('name field', () => document.querySelector<HTMLInputElement>('[data-testid=saved-name]'));
    typeInto(nameInput, 'Brazil customers');
    nameInput.form!.requestSubmit();
    await waitFor('saved item', () => byText('.saved-name', 'Brazil customers'));
    editor.setValue('-- scratch');
    byText('.saved-name', 'Brazil customers')!
      .closest('[data-testid=saved-item]')!
      .querySelector<HTMLButtonElement>('[data-testid=run-saved]')!
      .click();
    await waitFor('saved query results', () => status().startsWith('3 rows'));
  });

  await step('switch back to the orders table tab', async () => {
    byText('.editor-tab .tab-label', `orders [${name}]`)!.closest<HTMLElement>('.editor-tab')!.click();
    (await waitFor('Data mode button', () => visibleAll('.segmented button').find((b) => b.textContent === 'Data'))).click();
    await waitFor('orders grid visible', () => visibleCells('status').length > 0);
  });

  await step('console text persists to disk', async () => {
    await sleep(600);
    const connection = (await api.listConnections()).find((c) => c.name === name)!;
    if (!(await api.loadConsole(connection.id)).includes('-- scratch')) throw new Error('console was not saved');
  });
}

/** Adds the sample-DB connection through the form, without a password (PGlite accepts any). */
async function addSampleConnection(port: number): Promise<void> {
  if ((await api.listConnections()).some((c) => c.name === SAMPLE_NAME)) return;
  document.querySelector<HTMLButtonElement>('button[title="New connection"]')!.click();
  await waitFor('connection form', () => document.querySelector('#connection-form'));
  typeInto(field('Name'), SAMPLE_NAME);
  typeInto(field('Host'), '127.0.0.1');
  typeInto(field('Port'), String(port));
  typeInto(field('Database'), 'postgres');
  typeInto(field('User'), 'postgres');
  byText('button', 'Save')!.click();
  await waitFor('sample connection in explorer', () => treeRow(SAMPLE_NAME));
}

/** Runs the DataGrip import scenario. */
async function importScenario(config: SelfTestConfig): Promise<void> {
  if (config.addSample) await step('add the sample DB connection', () => addSampleConnection(config.samplePort ?? 54329));
  await step('import every DataGrip data source through the dialog', async () => {
    document.querySelector<HTMLButtonElement>('button[title="Import from DataGrip"]')!.click();
    await waitFor('import candidates', () => all('.import-table tbody tr').length > 0);
    const rows = all('.import-table tbody tr').length;
    log.push(`     DataGrip data sources found: ${rows}`);
    await waitFor('import button enabled', () => all<HTMLButtonElement>('.modal-foot button.primary').find((b) => !b.disabled));
    all<HTMLButtonElement>('.modal-foot button.primary')[0].click();
    await waitFor('import toast', () => byText('.toast', /Imported \d+ connection/));
    log.push(`     ${byText('.toast', /Imported/)!.textContent}`);
  });

  await step('imported connections are listed, prod ones read-only', async () => {
    const connections = await api.listConnections();
    const imported = connections.filter((c) => c.datagripUuid);
    if (config.expectedImports !== undefined && imported.length !== config.expectedImports)
      throw new Error(`expected ${config.expectedImports} imports, got ${imported.length}`);
    for (const c of imported) {
      if (/prod/i.test(c.name) !== c.readOnly) throw new Error(`${c.name}: read-only should be ${/prod/i.test(c.name)}`);
      log.push(`     ${c.name.padEnd(30)} ${c.readOnly ? 'READ-ONLY' : 'read-write'}  ssl=${c.sslMode}  port=${c.port}`);
    }
    await waitFor('rows in explorer', () => all('.connection-row').length >= imported.length);
  });

  await step('opening an imported connection asks for its password (no server contact yet)', async () => {
    const target = (await api.listConnections()).find((c) => c.datagripUuid && !c.passwordSaved);
    if (!target) return;
    treeRow(target.name)!.click();
    await waitFor('password prompt', () => byText('.modal-head h2', `Connect to ${target.name}`));
    byText('.modal-foot button', 'Cancel')!.click();
    await waitFor('prompt closed', () => !document.querySelector('.modal'));
  });
}

/**
 * Runs the DataGrip password-copy scenario against a fake DataGrip project (two data sources on
 * the sample DB) and fake DataGrip Keychain items held in memory: only "Fake shop dev" has one.
 */
async function passwordsScenario(config: SelfTestConfig): Promise<void> {
  await step('import the fake DataGrip project', async () => {
    document.querySelector<HTMLButtonElement>('button[title="Import from DataGrip"]')!.click();
    const dir = await waitFor('import folder field', () => document.querySelector<HTMLInputElement>('.import-dir input'));
    await waitFor('default scan finished', () => dir.value !== '');
    typeInto(dir, config.datagripDir!);
    byText('.import-dir button', 'Scan')!.click();
    await waitFor('fake sources listed', () => all('.import-table tbody tr').length === 2 && byText('.import-table td', 'Fake shop dev'));
    all<HTMLButtonElement>('.modal-foot button.primary')[0].click();
    await waitFor('imported', () => treeRow('Fake shop dev') && treeRow('Fake shop prod'));
  });

  await step('copy passwords from DataGrip: one copied, one not found, nothing leaked to the UI', async () => {
    document.querySelector<HTMLButtonElement>('[data-testid=copy-passwords]')!.click();
    (await waitFor('confirm button', () => document.querySelector<HTMLButtonElement>('[data-testid=start-copy]'))).click();
    const results = await waitFor('copy results', () => document.querySelector('[data-testid=copy-results]'));
    const text = results.textContent ?? '';
    log.push(`     ${text.replace(/\s+/g, ' ')}`);
    if (!/Fake shop dev.*Copied/.test(text) || !/Fake shop prod.*No password saved in DataGrip/.test(text))
      throw new Error(`unexpected results: ${text}`);
    if (document.body.innerHTML.includes('fake-password')) throw new Error('password leaked into the page');
    byText('.modal-foot button', 'Done')!.click();
    const listed = await api.listConnections();
    if (!listed.find((c) => c.name === 'Fake shop dev')?.passwordSaved) throw new Error('dev connection should have a saved password');
  });

  await step('the copied connection opens without asking for a password', async () => {
    treeRow('Fake shop dev')!.click();
    await waitFor('tables of the copied connection', () => treeRow('customers'), 15_000);
    if (document.querySelector('.modal')) throw new Error('no password prompt expected');
  });

  await step('the other connection asks, and "Use the password saved in DataGrip" explains there is none', async () => {
    treeRow('Fake shop prod')!.click();
    (
      await waitFor('use DataGrip password link', () => document.querySelector<HTMLButtonElement>('[data-testid=use-datagrip-password]'))
    ).click();
    await waitFor('explanation', () => byText('.modal .status.error', /no saved password/i));
    byText('.modal-foot button', 'Cancel')!.click();
  });
}

/**
 * Loading states against a real PostgreSQL (pnpm real-db): connecting spinner, schema skeleton,
 * table skeleton, dimmed reload with progress bar, and Stop on a deliberately slow page.
 */
async function loadingScenario(config: SelfTestConfig): Promise<void> {
  const name = 'Real Postgres (loading test)';
  await step('create a connection to the real database', async () => {
    document.querySelector<HTMLButtonElement>('button[title="New connection"]')!.click();
    await waitFor('connection form', () => document.querySelector('#connection-form'));
    typeInto(field('Name'), name);
    typeInto(field('Host'), '127.0.0.1');
    typeInto(field('Port'), String(config.realPort));
    typeInto(field('Database'), 'postgres');
    typeInto(field('User'), 'postgres');
    typeInto(field('Password'), config.realPassword ?? '');
    byText('button', 'Save')!.click();
    await waitFor('connection in explorer', () => treeRow(name));
  });

  await step('connecting shows a spinner, then the schema skeleton, then the tree', async () => {
    const watch = watchAppearances(['.phase-label', '.skeleton-tree']);
    treeRow(name)!.click();
    await waitFor('connected', async () => (await api.listConnections()).find((c) => c.name === name)?.connected, 15_000);
    await waitFor('database node', () => treeRow('postgres'), 15_000);
    watch.stop();
    expectSeen(watch, ['.phase-label', '.skeleton-tree'], 'connecting');
  });

  await step('create a demo table from a console and refresh the explorer', async () => {
    treeRow(name)!
      .closest('.tree-row')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const editor = await waitFor('console editor', () => visibleEditor());
    editor.setValue(
      'drop view if exists slow_demo;\ndrop table if exists loading_demo;\ncreate table loading_demo as select g as id, md5(g::text) as label, now() as created_at from generate_series(1, 2000) g;\ncreate view slow_demo as select d.*, pg_sleep(0.008) is not null as slept from loading_demo d;',
    );
    document.querySelector<HTMLButtonElement>('[data-testid=run-all]')!.click();
    await waitFor('table created', () => all('.results-tab').length === 4 && !document.querySelector('.results-tab.running'));
    await waitFor('demo table in explorer', () => treeRow('loading_demo'), 15_000);
  });

  await step('opening a table shows a skeleton grid with its real columns first', async () => {
    const watch = watchAppearances(['[data-testid=skeleton-grid]', '.progress-bar.active']);
    treeRow('loading_demo')!.click();
    await waitFor('first page', () => pageRange() === '1–500');
    watch.stop();
    expectSeen(watch, ['[data-testid=skeleton-grid]', '.progress-bar.active'], 'first load');
  });

  await step('paging keeps the old rows dimmed under a progress bar instead of blanking', async () => {
    const watch = watchAppearances(['.grid-holder.dimmed', '.progress-bar.active']);
    document.querySelector<HTMLButtonElement>('[data-testid=next-page]')!.click();
    await waitFor('second page', () => pageRange() === '501–1,000');
    watch.stop();
    expectSeen(watch, ['.grid-holder.dimmed', '.progress-bar.active'], 'paging');
    if (visibleAll('[data-testid=skeleton-grid]').length) throw new Error('paging should not fall back to the skeleton');
  });

  await step('Stop cancels a slow page and keeps the previous rows', async () => {
    const filter = visibleAll<HTMLInputElement>('[data-testid=filter-input]')[0] as HTMLInputElement;
    typeInto(filter, 'pg_sleep(20) is not null');
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const stopButton = await waitFor('stop button', () => visibleAll<HTMLButtonElement>('[data-testid=stop-loading]')[0]);
    await snap('reloading-dimmed');
    const started = performance.now();
    (stopButton as HTMLButtonElement).click();
    await waitFor('stopped banner', () => visibleAll('[data-testid=stopped-banner]')[0], 5_000);
    log.push(`     stopped after ${Math.round(performance.now() - started)} ms; previous rows kept: ${visibleCells('id').length}`);
    if (visibleCells('id').length === 0) throw new Error('previous rows should stay visible');
    visibleAll<HTMLButtonElement>('button[title="Clear filter"]')[0]?.click();
    await waitFor('rows again', () => pageRange() === '1–500');
  });

  await step('a slow first load shows the skeleton grid with the real column names', async () => {
    document.querySelector<HTMLButtonElement>('[data-testid=toggle-all-kinds]')!.click();
    await waitFor('slow view in explorer', () => treeRow('slow_demo'));
    treeRow('slow_demo')!.click();
    const skeleton = await waitFor('skeleton grid', () => visibleAll('[data-testid=skeleton-grid]')[0]);
    const headers = [...skeleton.querySelectorAll('.col-name')].map((h) => h.textContent).join(',');
    if (headers !== 'id,label,created_at,slept') throw new Error(`skeleton headers should be the view's columns, got ${headers}`);
    await snap('first-load-skeleton');
    await waitFor('slow view loaded', () => pageRange() === '1–500', 15_000);
    document.querySelector<HTMLButtonElement>('[data-testid=toggle-all-kinds]')!.click();
  });
}

/** UI preferences kept in localStorage, which the installed app shares (same app identifier). */
const PREFERENCE_KEYS = ['datagrabber.explorer.showAllKinds', 'datagrabber.console.libraryOpen'];

/** Clears UI preferences so the test starts from defaults; returns a function restoring the user's values. */
function isolatePreferences(): () => void {
  const saved = PREFERENCE_KEYS.map((key) => [key, localStorage.getItem(key)] as const);
  for (const key of PREFERENCE_KEYS) localStorage.removeItem(key);
  return () => {
    for (const [key, value] of saved) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  };
}

/** Runs the self-test described by `config` and reports the outcome to the process. */
export async function runSelfTest(config: SelfTestConfig): Promise<void> {
  const restorePreferences = isolatePreferences();
  let ok = true;
  try {
    await waitFor('explorer', () => document.querySelector('.explorer'));
    const showAll = document.querySelector<HTMLButtonElement>('[data-testid=toggle-all-kinds]');
    if (showAll?.getAttribute('aria-pressed') === 'true') showAll.click();
    await sleep(300);
    if (config.scenario === 'sample') await sampleScenario(config);
    else if (config.scenario === 'passwords') await passwordsScenario(config);
    else if (config.scenario === 'loading') await loadingScenario(config);
    else await importScenario(config);
  } catch (error) {
    ok = false;
    log.push(`FAIL ${(error as Error).message}`);
  }
  await api.e2eLog('ready-for-screenshot');
  await sleep(config.holdMs ?? 0);
  restorePreferences();
  await api.e2eReport(ok, log);
}
