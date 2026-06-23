import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import App from './App';
import { WorkbenchProvider } from './workbench/store';

// Ask the browser to make our storage persistent so the downloaded corpus (SQLite-WASM over OPFS) isn't
// evicted when disk runs low. Browsers grant this readily once the app is installed as a PWA.
if (navigator.storage?.persist) {
  const tryPersist = () =>
    navigator.storage.persisted().then((already) => {
      if (!already) return navigator.storage.persist().catch(() => false);
      return true;
    });
  tryPersist();
  // Browsers often deny persist() without a user gesture, so retry once on the first interaction.
  const onGesture = () => {
    tryPersist();
  };
  addEventListener('pointerdown', onGesture, { once: true });
  addEventListener('click', onGesture, { once: true });
}

const theme = createTheme({ primaryColor: 'orange', fontFamily: 'inherit' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme}>
      <BrowserRouter>
        <WorkbenchProvider>
          <App />
        </WorkbenchProvider>
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>
);
