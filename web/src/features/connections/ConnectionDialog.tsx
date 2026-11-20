import { useState, type FormEvent } from 'react';
import type { ConnectionConfig, ConnectionInput, SslMode } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Modal } from './Modal.tsx';

const COLORS = ['#64748b', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#d97706', '#dc2626'];

type ConnectionDialogProps = {
  connection?: ConnectionConfig;
  onClose: () => void;
  onSaved: (connection: ConnectionConfig) => void;
};

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; message: string } | { kind: 'error'; message: string };

const EMPTY: ConnectionInput = { name: '', host: 'localhost', port: 5432, database: 'postgres', user: 'postgres', sslMode: 'prefer', readOnly: false, color: COLORS[0] };

/** Editable fields of a saved connection. */
function toInput({ name, host, port, database, user, sslMode, readOnly, color, datagripUuid }: ConnectionConfig): ConnectionInput {
  return { name, host, port, database, user, sslMode, readOnly, color, datagripUuid };
}

/**
 * Create/edit form for a connection. The password field is optional when editing: leaving it
 * blank keeps whatever is saved in the keychain.
 */
export function ConnectionDialog({ connection, onClose, onSaved }: ConnectionDialogProps) {
  const [form, setForm] = useState<ConnectionInput>(() => (connection ? toInput(connection) : EMPTY));
  const [password, setPassword] = useState('');
  const [savePassword, setSavePassword] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const set = <K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const passwordChoice = password ? { password, savePassword } : {};

  const test = async () => {
    setStatus({ kind: 'busy' });
    try {
      const result = await api.testConnection(form, connection?.id, password || undefined);
      setStatus({ kind: 'ok', message: `Connected — PostgreSQL ${result.serverVersion}` });
    } catch (error) {
      const message = error instanceof ApiError && error.needsPassword && !password ? 'Enter the password to test.' : (error as Error).message;
      setStatus({ kind: 'error', message });
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setStatus({ kind: 'busy' });
    try {
      const saved = connection ? await api.updateConnection(connection.id, form, passwordChoice) : await api.createConnection(form, passwordChoice);
      onSaved(saved);
    } catch (error) {
      setStatus({ kind: 'error', message: (error as Error).message });
    }
  };

  return (
    <Modal
      title={connection ? `Edit ${connection.name}` : 'New PostgreSQL connection'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={test} disabled={status.kind === 'busy'}>Test connection</button>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="connection-form" className="primary" disabled={status.kind === 'busy'}>Save</button>
        </>
      }
    >
      <form id="connection-form" className="form-grid" onSubmit={save}>
        <label className="span-2">Name<input autoFocus required value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="orders-prod" /></label>
        <label>Host<input required value={form.host} onChange={(e) => set('host', e.target.value)} /></label>
        <label>Port<input required type="number" min={1} max={65535} value={form.port} onChange={(e) => set('port', Number(e.target.value))} /></label>
        <label>Database<input required value={form.database} onChange={(e) => set('database', e.target.value)} /></label>
        <label>User<input required value={form.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" /></label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={connection?.passwordSaved ? 'Saved in Keychain — leave blank to keep' : 'Asked on connect if blank'} />
        </label>
        <label>
          SSL
          <select value={form.sslMode} onChange={(e) => set('sslMode', e.target.value as SslMode)}>
            <option value="disable">disable</option>
            <option value="prefer">prefer (TLS if available)</option>
            <option value="require">require (TLS, no cert check)</option>
            <option value="verify-full">verify-full (TLS + cert check)</option>
          </select>
        </label>
        <label className="check span-2"><input type="checkbox" checked={savePassword} disabled={!password} onChange={(e) => setSavePassword(e.target.checked)} />Save password in macOS Keychain</label>
        <label className="check span-2"><input type="checkbox" checked={form.readOnly} onChange={(e) => set('readOnly', e.target.checked)} />Read-only (every session starts with read-only transactions)</label>
        <div className="span-2 color-row">
          Color
          {COLORS.map((c) => (
            <button type="button" key={c} className={`swatch${form.color === c ? ' selected' : ''}`} style={{ background: c }} onClick={() => set('color', c)} aria-label={`Color ${c}`} />
          ))}
        </div>
      </form>
      {status.kind === 'busy' && <p className="status muted">Working…</p>}
      {status.kind === 'ok' && <p className="status ok">{status.message}</p>}
      {status.kind === 'error' && <p className="status error">{status.message}</p>}
    </Modal>
  );
}
