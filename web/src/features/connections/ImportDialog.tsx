import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';
import type { DatagripCandidate } from '../../lib/types.ts';
import { Modal } from '../../ui/Modal.tsx';

type ImportDialogProps = { onClose: () => void; onImported: (count: number) => void };

/**
 * Lists the data sources of a DataGrip project and imports the selected ones. Only connection
 * metadata is read; passwords are asked on first connect because DataGrip keeps them encrypted.
 */
export function ImportDialog({ onClose, onImported }: ImportDialogProps) {
  const [dir, setDir] = useState('');
  const [candidates, setCandidates] = useState<DatagripCandidate[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = async (folder?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const preview = await api.previewDatagrip(folder);
      setDir(preview.dir);
      setCandidates(preview.candidates);
      setSelected(new Set(preview.candidates.filter((c) => c.importable).map((c) => c.uuid)));
    } catch (e) {
      setCandidates(undefined);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: scan the default folder once, when the dialog opens
  useEffect(() => {
    load();
  }, []);

  const toggle = (uuid: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });

  const runImport = async () => {
    setBusy(true);
    try {
      const imported = await api.importDatagrip([...selected], dir);
      onImported(imported.length);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title="Import from DataGrip"
      onClose={onClose}
      footer={
        <>
          <span className="muted small">Passwords stay in DataGrip's encrypted store — you'll be asked once per connection.</span>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={runImport} disabled={busy || selected.size === 0}>
            Import {selected.size || ''}
          </button>
        </>
      }
    >
      <div className="import-dir">
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/DataGripProjects/.idea" />
        <button type="button" className="ghost" onClick={() => load(dir)} disabled={busy}>
          Scan
        </button>
      </div>
      {error && <p className="status error">{error}</p>}
      {candidates && candidates.length === 0 && <p className="muted">No data sources found in this folder.</p>}
      {candidates && candidates.length > 0 && (
        <table className="import-table">
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>Host</th>
              <th>Database</th>
              <th>User</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={c.uuid} className={c.importable ? '' : 'disabled'}>
                <td>
                  <input
                    type="checkbox"
                    disabled={!c.importable}
                    checked={selected.has(c.uuid)}
                    onChange={() => toggle(c.uuid)}
                    aria-label={`Import ${c.name}`}
                  />
                </td>
                <td>
                  {c.name}
                  {/prod/i.test(c.name) && <span className="badge ro">RO</span>}
                </td>
                <td className="mono">{c.host ? `${c.host}:${c.port}` : '—'}</td>
                <td className="mono">{c.database ?? '—'}</td>
                <td className="mono">{c.user ?? '—'}</td>
                <td className="muted small">{c.reason ?? (c.existingId ? 'updates existing' : 'new')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
