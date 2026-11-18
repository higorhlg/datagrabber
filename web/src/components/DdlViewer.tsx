import { Editor } from '@monaco-editor/react';
import { useEditorTheme } from '../theme.ts';

type DdlViewerProps = { ddl: string | undefined; error?: string };

/** Read-only, highlighted DDL. */
export function DdlViewer({ ddl, error }: DdlViewerProps) {
  const theme = useEditorTheme();
  if (error) return <div className="query-error"><strong>{error}</strong></div>;
  if (ddl === undefined) return <div className="grid-message">Loading DDL…</div>;
  return (
    <div className="ddl-viewer" data-testid="ddl-viewer">
      <Editor
        value={ddl}
        defaultLanguage="pgsql"
        theme={theme}
        options={{ readOnly: true, domReadOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true, renderLineHighlight: 'none', lineNumbers: 'on' }}
      />
    </div>
  );
}
