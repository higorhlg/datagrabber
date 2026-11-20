import { loader } from '@monaco-editor/react';
import type * as MonacoTypes from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { registerSqlCompletion } from './completion.ts';
import * as monacoRuntime from './entry.ts';

/**
 * Bundles Monaco locally (no CDN, PostgreSQL language only), registers SQL completion and the app's editor themes.
 * Imported once from main.tsx before any editor renders.
 */
const monaco = monacoRuntime as unknown as typeof MonacoTypes;

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
registerSqlCompletion(monaco);

monaco.editor.defineTheme('datagrabber-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#1e1f22', 'editorGutter.background': '#1e1f22', 'editor.lineHighlightBackground': '#26282e' },
});
monaco.editor.defineTheme('datagrabber-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#ffffff' },
});

export { monaco };
