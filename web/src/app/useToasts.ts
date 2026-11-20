import { useCallback, useState } from 'react';

export type Toast = { id: number; message: string };

const TOAST_MS = 4500;

/** Short-lived notifications; `notify` is stable so it can be passed down freely. */
export function useToasts(): { toasts: Toast[]; notify: (message: string) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), TOAST_MS);
  }, []);
  return { toasts, notify };
}
