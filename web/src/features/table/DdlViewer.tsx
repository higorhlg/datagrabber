import { Editor } from '@monaco-editor/react';
import { MONO_FONT_FAMILY } from '../../lib/fonts.ts';
import { useEditorTheme } from '../../lib/theme.ts';
import { LoadingMessage } from '../../ui/Loading.tsx';

type DdlViewerProps = { ddl: string | undefined; error?: string };

/** Read-only, highlighted DDL. */
export function DdlViewer({ ddl, error }: DdlViewerProps) {
  const theme = useEditorTheme();
  if (error)
    return (
      <div className="query-error">
        <strong>{error}</strong>
      </div>
    );
  if (ddl === undefined) return <LoadingMessage>Loading DDL…</LoadingMessage>;
  return (
    <div className="ddl-viewer" data-testid="ddl-viewer">
      <Editor
        value={ddl}
        defaultLanguage="pgsql"
        theme={theme}
        options={{
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: MONO_FONT_FAMILY,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          renderLineHighlight: 'none',
          lineNumbers: 'on',
        }}
      />
    </div>
  );
}
