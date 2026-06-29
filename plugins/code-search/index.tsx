// Code — a SQLite workbench page. The heavy Monaco editor lives in CodePage.tsx and is lazy-loaded
// (a separate chunk fetched only when you open the Code tab), so it stays out of the initial bundle.
import { lazy, Suspense } from 'react';
import { definePlugin } from '../../src/plugins/types';
import { CODE_PAGE_ID, codePageApi } from './api';

const CodePage = lazy(() => import('./CodePage'));

export default definePlugin({
  manifest: { id: 'code-search', name: 'Code', version: '2.0.0', apiVersion: '^1', permissions: ['data:read'], description: 'A SQLite workbench (Monaco) with gematria() + evalJS().' },
  activate(ctx) {
    // Publish the Code page's extension API so other plugins can extend it: getApi(CODE_PAGE_ID)(theirCtx).
    // We expose the FACTORY (not a bound instance) so each consumer's renderers/fns/samples are tracked under
    // THAT plugin's context and disposed when it unloads.
    ctx.exposeApi(CODE_PAGE_ID, codePageApi);
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
