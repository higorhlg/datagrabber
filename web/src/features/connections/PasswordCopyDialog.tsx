import { CheckCircle2, CircleSlash, KeyRound, ShieldAlert } from 'lucide-react';
import type { PasswordCopyResult } from '../../lib/api.ts';
import { platform } from '../../lib/platform.ts';
import { Modal } from '../../ui/Modal.tsx';

export type PasswordCopyState = { phase: 'confirm' } | { phase: 'running' } | { phase: 'done'; results: PasswordCopyResult[] };

type PasswordCopyDialogProps = {
  state: PasswordCopyState;
  /** Imported connections that have no saved password yet. */
  pendingCount: number;
  onStart: () => void;
  onClose: () => void;
};

const STATUS_TEXT: Record<PasswordCopyResult['status'], string> = {
  copied: `Copied to Datagrabber's entry in the ${platform.keychain}`,
  'already-saved': 'Already has a saved password (skipped)',
  'not-found': 'No password saved in DataGrip',
  'not-imported': 'Not imported from DataGrip',
  unavailable: `Not copied — access was denied or the ${platform.keychain} is unavailable`,
  error: 'Could not save',
};

/** Explains, runs and reports copying the passwords DataGrip saved in the OS keychain into Datagrabber. */
export function PasswordCopyDialog({ state, pendingCount, onStart, onClose }: PasswordCopyDialogProps) {
  const copied = state.phase === 'done' ? state.results.filter((r) => r.status === 'copied').length : 0;
  return (
    <Modal
      title="Copy passwords from DataGrip"
      onClose={state.phase === 'running' ? () => undefined : onClose}
      footer={
        <>
          <span className="spacer" />
          {state.phase === 'confirm' && (
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
          )}
          {state.phase === 'confirm' && (
            <button type="button" className="primary" onClick={onStart} disabled={pendingCount === 0} data-testid="start-copy">
              Copy {pendingCount} password{pendingCount === 1 ? '' : 's'}
            </button>
          )}
          {state.phase === 'done' && (
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          )}
        </>
      }
    >
      {state.phase === 'confirm' && (
        <div className="copy-explainer">
          <p>
            <KeyRound size={14} className="ic-key" /> DataGrip keeps your database passwords in the {platform.keychain}. Datagrabber can
            copy them into its own entries there so your imported connections open without typing them.
          </p>
          <ul>
            <li>
              {platform.isMac ? (
                <>
                  macOS asks you to <strong>Allow</strong> each DataGrip item. Click <em>Allow</em> (or <em>Always Allow</em>);{' '}
                  <em>Deny</em> skips that connection.
                </>
              ) : (
                <>Your keyring may ask you to unlock it first; cancelling skips the remaining connections.</>
              )}
            </li>
            <li>
              Passwords go straight from one keyring item to another inside the app. They are never shown, logged or written to files.
            </li>
            <li>Connections that already have a saved password are left alone.</li>
          </ul>
          {pendingCount === 0 && <p className="muted">Every imported connection already has a saved password.</p>}
        </div>
      )}
      {state.phase === 'running' && <p className="muted">Copying… answer the {platform.keychain} prompts as they appear.</p>}
      {state.phase === 'done' && (
        <>
          <p>
            {copied} of {state.results.length} password{state.results.length === 1 ? '' : 's'} copied.
          </p>
          <ul className="copy-results" data-testid="copy-results">
            {state.results.map((r) => (
              <li key={r.id}>
                {r.status === 'copied' ? (
                  <CheckCircle2 size={14} className="ok-icon" />
                ) : r.status === 'unavailable' || r.status === 'error' ? (
                  <ShieldAlert size={14} className="error-text" />
                ) : (
                  <CircleSlash size={14} className="muted" />
                )}
                <strong>{r.name}</strong>
                <span className="muted">
                  {STATUS_TEXT[r.status]}
                  {r.message && r.status !== 'not-found' ? ` (${r.message})` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
