import { useCallback, useState } from 'react';
import type { ConsoleRequest } from '../features/console/ConsoleView.tsx';
import { consoleTabKey, type Tab } from './tabs.ts';

/**
 * Open editor tabs, the active one, and one-shot requests for consoles (run or insert SQL coming
 * from elsewhere, e.g. "Open this query in a console").
 */
export function useTabs() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string>();
  const [consoleRequests, setConsoleRequests] = useState<Record<string, ConsoleRequest | undefined>>({});

  /** Opens a tab, or focuses it if already open (a table tab also switches to the requested mode). */
  const open = useCallback((tab: Tab) => {
    setTabs((current) => {
      if (!current.some((t) => t.key === tab.key)) return [...current, tab];
      return current.map((t) => (t.key === tab.key && t.kind === 'table' && tab.kind === 'table' ? { ...t, mode: tab.mode } : t));
    });
    setActiveKey(tab.key);
  }, []);

  /** Closes a tab, activating its neighbour when it was the active one. */
  const close = useCallback((key: string) => {
    setTabs((current) => {
      const index = current.findIndex((t) => t.key === key);
      const next = current.filter((t) => t.key !== key);
      setActiveKey((active) => (active === key ? next[Math.min(index, next.length - 1)]?.key : active));
      return next;
    });
  }, []);

  const closeConnection = useCallback((connectionId: string) => {
    setTabs((current) => current.filter((t) => t.connectionId !== connectionId));
  }, []);

  const setTableMode = useCallback((key: string, mode: 'data' | 'ddl') => {
    setTabs((current) => current.map((t) => (t.key === key && t.kind === 'table' ? { ...t, mode } : t)));
  }, []);

  /** Queues SQL for a connection's console (the console tab must be opened by the caller). */
  const sendToConsole = useCallback((connectionId: string, kind: ConsoleRequest['kind'], sql: string) => {
    setConsoleRequests((r) => ({ ...r, [connectionId]: { kind, sql, nonce: Date.now() } }));
    setActiveKey(consoleTabKey(connectionId));
  }, []);

  return { tabs, activeKey, setActiveKey, consoleRequests, open, close, closeConnection, setTableMode, sendToConsole };
}
