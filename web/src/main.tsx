import './lib/monaco/setup.ts';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { api } from './lib/api.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/** The end-to-end self-test is loaded only when the app was launched for one (see dev/e2e.ts). */
api
  .e2eConfig()
  .then(async (config) => {
    if (!config) return;
    const { runSelfTest } = await import('./testing/selftest.ts');
    await runSelfTest(config as never);
  })
  .catch(() => undefined);
