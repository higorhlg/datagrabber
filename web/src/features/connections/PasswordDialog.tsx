import { useState, type FormEvent } from 'react';
import type { ConnectionConfig } from '../../../shared/types.ts';
import { Modal } from './Modal.tsx';

type PasswordDialogProps = {
  connection: ConnectionConfig;
  error?: string;
  onSubmit: (password: string, savePassword: boolean) => void;
  /** Shown for DataGrip imports: copy DataGrip's saved password from the Keychain, then connect. */
  onUseDatagrip?: () => void;
  onCancel: () => void;
};

/** Asks for a connection's password at connect time, optionally saving it to the keychain. */
export function PasswordDialog({ connection, error, onSubmit, onUseDatagrip, onCancel }: PasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(true);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(password, save);
  };
  return (
    <Modal
      title={`Connect to ${connection.name}`}
      onClose={onCancel}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" form="password-form" className="primary">Connect</button>
        </>
      }
    >
      <form id="password-form" className="form-grid" onSubmit={submit}>
        <p className="span-2 muted mono">{connection.user}@{connection.host}:{connection.port}/{connection.database}</p>
        <label className="span-2">Password<input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        <label className="check span-2"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />Save in macOS Keychain</label>
        {onUseDatagrip && (
          <p className="span-2 small">
            <button type="button" className="link" onClick={onUseDatagrip} data-testid="use-datagrip-password">Use the password saved in DataGrip</button>
            <span className="muted"> — macOS will ask you to allow access.</span>
          </p>
        )}
      </form>
      {error && <p className="status error">{error}</p>}
    </Modal>
  );
}
