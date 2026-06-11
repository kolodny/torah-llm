// Code — a SQLite workbench page. The heavy Monaco editor lives in CodePage.tsx and is lazy-loaded
// (a separate chunk fetched only when you open the Code tab), so it stays out of the initial bundle.
import { lazy, Suspense } from 'react';
import { definePlugin } from '../../src/plugins/types';

const CodePage = lazy(() => import('./CodePage'));

export default definePlugin({
  manifest: { id: 'code-search', name: 'Code', version: '2.0.0', apiVersion: '^1', permissions: ['data:read'], description: 'A SQLite workbench (Monaco) with gematria() + evalJS().' },
  activate(ctx) {
    ctx.registerPage({
      id: 'code-search',
      title: 'Code',
      icon: '›_',
      order: 20,
      render: () => (
        <Suspense fallback={<div className="plugin-page"><p className="muted">Loading editor…</p></div>}>
          <CodePage ctx={ctx} />
        </Suspense>
      ),
    });
  },
});
