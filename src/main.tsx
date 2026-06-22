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
  navigator.storage.persisted().then((already) => {
    if (!already) navigator.storage.persist().catch(() => {});
  });
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
