import { useCallback, useEffect, useRef, useState } from 'react';
import type { PasswordCopyState } from '../features/connections/PasswordCopyDialog.tsx';
import type { ConnectionPhase, SchemaState } from '../features/explorer/DatabaseExplorer.tsx';
import { ApiError, api, type PasswordCopyResult } from '../lib/api.ts';
import type { ConnectionConfig, ConnectionSummary, DatabaseSchema } from '../lib/types.ts';

/** The password dialog's state: which connection, the last error, and how to finish the wait. */
export type PasswordPrompt = { connection: ConnectionConfig; error?: string; resolve: (connected: boolean) => void };

/** The introspected schema when it has finished loading. */
export function readySchema(state: SchemaState | undefined): DatabaseSchema | undefined {
  return state?.status === 'ready' ? state.schema : undefined;
}

/**
 * Saved connections and their live state: sessions, connection phases and errors, schemas,
 * the password prompt, and copying passwords from DataGrip.
 */
export function useConnections(notify: (message: string) => void) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [schemas, setSchemas] = useState<Record<string, SchemaState | undefined>>({});
  const [serverVersions, setServerVersions] = useState<Record<string, string>>({});
  const [phases, setPhases] = useState<Record<string, ConnectionPhase | undefined>>({});
  const [connectErrors, setConnectErrors] = useState<Record<string, string | undefined>>({});
  const [prompt, setPrompt] = useState<PasswordPrompt>();
  const [passwordCopy, setPasswordCopy] = useState<PasswordCopyState>();
  const attempts = useRef(new Map<string, Promise<boolean>>());
  const schemasRef = useRef(schemas);
  schemasRef.current = schemas;

  const refresh = useCallback(async () => {
    try {
      setConnections(await api.listConnections());
    } catch (error) {
      notify((error as Error).message);
    }
  }, [notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Loads (or reloads, keeping the old tree visible) a connection's schema. */
  const loadSchema = useCallback(async (id: string) => {
    setSchemas((s) => {
      const current = s[id];
      return { ...s, [id]: current?.status === 'ready' ? { ...current, refreshing: true } : { status: 'loading' } };
    });
    try {
      const schema = await api.schema(id);
      setSchemas((s) => ({ ...s, [id]: { status: 'ready', schema } }));
    } catch (error) {
      setSchemas((s) => ({ ...s, [id]: { status: 'error', message: (error as Error).message } }));
    }
  }, []);

  const rememberVersion = useCallback((id: string, serverVersion: string) => setServerVersions((v) => ({ ...v, [id]: serverVersion })), []);

  /** Shows the password dialog; resolves true once a connect with the typed password succeeds. */
  const askPassword = useCallback(
    (connection: ConnectionConfig, error?: string) => new Promise<boolean>((resolve) => setPrompt({ connection, error, resolve })),
    [],
  );

  /**
   * Makes sure a session is open, asking for a password when none is saved or it was rejected.
   * Concurrent callers for the same connection share one attempt.
   */
  const ensureConnected = useCallback(
    (connection: ConnectionConfig): Promise<boolean> => {
      const pending = attempts.current.get(connection.id);
      if (pending) return pending;
      const setPhase = (phase: ConnectionPhase | undefined) => setPhases((p) => ({ ...p, [connection.id]: phase }));
      const attempt = (async () => {
        setPhase('connecting');
        setConnectErrors((e) => ({ ...e, [connection.id]: undefined }));
        let connected = false;
        try {
          rememberVersion(connection.id, (await api.connect(connection.id)).serverVersion);
          connected = true;
        } catch (error) {
          if (error instanceof ApiError && error.needsPassword) {
            setPhase('password');
            connected = await askPassword(connection, error.message === 'Password required' ? undefined : error.message);
          } else {
            setConnectErrors((e) => ({ ...e, [connection.id]: (error as Error).message }));
          }
        }
        if (connected) {
          if (!readySchema(schemasRef.current[connection.id])) loadSchema(connection.id);
          await refresh();
        }
        return connected;
      })().finally(() => {
        setPhase(undefined);
        attempts.current.delete(connection.id);
      });
      attempts.current.set(connection.id, attempt);
      return attempt;
    },
    [askPassword, loadSchema, refresh, rememberVersion],
  );

  const ensureRef = useRef(ensureConnected);
  ensureRef.current = ensureConnected;
  const reconnectors = useRef(new Map<string, () => Promise<boolean>>());
  /** A stable reconnect callback per connection, so tabs don't reload when the app re-renders. */
  const reconnectFor = useCallback((connection: ConnectionConfig) => {
    let fn = reconnectors.current.get(connection.id);
    if (!fn) {
      fn = () => ensureRef.current(connection);
      reconnectors.current.set(connection.id, fn);
    }
    return fn;
  }, []);

  /** Password dialog submit: connect with the typed password, keeping the dialog open on failure. */
  const submitPassword = async (password: string, savePassword: boolean) => {
    if (!prompt) return;
    try {
      rememberVersion(prompt.connection.id, (await api.connect(prompt.connection.id, { password, savePassword })).serverVersion);
      prompt.resolve(true);
      setPrompt(undefined);
    } catch (error) {
      setPrompt({ ...prompt, error: (error as Error).message });
    }
  };

  const cancelPassword = () => {
    prompt?.resolve(false);
    setPrompt(undefined);
  };

  /** Copies the passwords DataGrip saved in the OS keychain (every imported connection, or the given ones). */
  const copyDatagripPasswords = async (ids?: string[]): Promise<PasswordCopyResult[]> => {
    setPasswordCopy({ phase: 'running' });
    try {
      const results = await api.copyDatagripPasswords(ids);
      setPasswordCopy({ phase: 'done', results });
      await refresh();
      return results;
    } catch (error) {
      setPasswordCopy(undefined);
      notify((error as Error).message);
      return [];
    }
  };

  /** "Use the password saved in DataGrip" in the password dialog: copy it, then connect with it. */
  const connectWithDatagripPassword = async () => {
    if (!prompt) return;
    const current = prompt;
    const [result] = await copyDatagripPasswords([current.connection.id]);
    setPasswordCopy(undefined);
    if (result?.status !== 'copied') {
      setPrompt({ ...current, error: result?.message ?? 'DataGrip has no saved password for this connection.' });
      return;
    }
    try {
      rememberVersion(current.connection.id, (await api.connect(current.connection.id)).serverVersion);
      current.resolve(true);
      setPrompt(undefined);
    } catch (error) {
      setPrompt({ ...current, error: (error as Error).message });
    }
  };

  const disconnect = async (connection: ConnectionSummary) => {
    await api.disconnect(connection.id);
    setSchemas((s) => ({ ...s, [connection.id]: undefined }));
    await refresh();
  };

  const forgetPassword = async (connection: ConnectionSummary) => {
    await api.forgetPassword(connection.id);
    await refresh();
    notify(`Forgot saved password for ${connection.name}`);
  };

  const remove = async (connection: ConnectionSummary) => {
    await api.deleteConnection(connection.id);
    await refresh();
    notify(`Deleted ${connection.name}`);
  };

  /** After a connection was edited: drop its cached schema (settings may point elsewhere now). */
  const afterSave = async (saved: ConnectionConfig) => {
    setSchemas((s) => ({ ...s, [saved.id]: undefined }));
    await refresh();
  };

  return {
    connections,
    schemas,
    serverVersions,
    phases,
    connectErrors,
    prompt,
    passwordCopy,
    setPasswordCopy,
    refresh,
    loadSchema,
    ensureConnected,
    reconnectFor,
    submitPassword,
    cancelPassword,
    copyDatagripPasswords,
    connectWithDatagripPassword,
    disconnect,
    forgetPassword,
    remove,
    afterSave,
  };
}
