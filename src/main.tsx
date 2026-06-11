import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import App from './App';
import { WorkbenchProvider } from './workbench/store';

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
