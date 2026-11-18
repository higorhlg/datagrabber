import { useEffect, useState } from 'react';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Monaco theme name following the OS light/dark appearance. */
export function useEditorTheme(): string {
  const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => setDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return dark ? 'datagrabber-dark' : 'datagrabber-light';
}
