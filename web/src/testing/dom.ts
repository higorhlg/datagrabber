import { monaco } from '../lib/monaco/setup.ts';

/** DOM helpers shared by the end-to-end self-test and the recorded demos. */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `find` returns a truthy value, failing with `what` after the timeout. */
export async function waitFor<T>(
  what: string,
  find: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await find();
    if (found) return found;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export const all = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
/** Elements currently rendered on screen (hidden tabs excluded). */
export const visibleAll = <T extends Element = HTMLElement>(selector: string) =>
  all<T>(selector).filter((el) => (el as unknown as HTMLElement).offsetParent !== null);
export const byText = (selector: string, text: string | RegExp) =>
  all(selector).find((el) => (typeof text === 'string' ? el.textContent?.trim() === text : text.test(el.textContent ?? '')));

/** Sets a React-controlled input's value the way typing would. */
export function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Finds the input inside a form label that starts with `text`. */
export function field(text: string): HTMLInputElement {
  const label = all('label').find((l) => l.textContent?.trim().startsWith(text));
  const input = label?.querySelector('input');
  if (!input) throw new Error(`No field labelled ${text}`);
  return input;
}

/** The editor in the visible console. */
export function visibleEditor() {
  return monaco.editor.getEditors().find((e) => (e.getDomNode()?.offsetParent ?? null) !== null);
}

export const status = () => document.querySelector('[data-testid=results-status]')?.textContent ?? '';
export const pageRange = () => document.querySelector('[data-testid=page-range]')?.textContent ?? '';
/** Explorer row label with exactly this text. */
export const treeRow = (label: string) => all('.tree-row .node-label').find((el) => el.textContent === label);
/** Values of one column in the visible table tab's grid. */
export function visibleCells(column: string): string[] {
  const view = all('[data-testid=table-view]').find((v) => v.offsetParent !== null);
  if (!view) return [];
  const index = visibleAll('.grid-head-cell .col-name')
    .filter((h) => view.contains(h))
    .findIndex((h) => h.textContent === column);
  return [...view.querySelectorAll('.grid-row')].map((r) => r.querySelectorAll('.grid-cell')[index]?.textContent ?? '');
}

/**
 * Records which of the given selectors appear in the DOM at any moment (even briefly), so fast
 * loading states can be asserted after the fact.
 */
export function watchAppearances(selectors: string[]): { seen: Set<string>; stop: () => void } {
  const seen = new Set<string>();
  const check = () => {
    for (const selector of selectors) if (document.querySelector(selector)) seen.add(selector);
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  check();
  return { seen, stop: () => observer.disconnect() };
}

/** Asserts that every watched selector showed up. */
export function expectSeen(watch: { seen: Set<string> }, selectors: string[], what: string): void {
  const missing = selectors.filter((s) => !watch.seen.has(s));
  if (missing.length) throw new Error(`${what}: never saw ${missing.join(', ')}`);
}
