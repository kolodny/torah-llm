// The Code page's extension API. Other plugins import this to extend the SQL workbench — the page owns the
// contract (slot names + types); core stays generic (it only knows about contribute()/useSlot()/data). Any
// page can follow this same pattern: export a `<page>Api(ctx)` factory + its contribution types.
import type { ReactNode } from 'react';
import type { Contribution, Disposable, PluginContext, SqlFnSpec } from '../../src/plugins/types';

export const CODE_PAGE_ID = 'code-search';

/** A rich renderer for a result cell, invoked by the SQL render('<renderer.id>', ...args) function. */
export type CellRenderer = Contribution & { render(args: unknown[]): ReactNode };

/** A query offered in the Code page's sample dropdown. */
export type CodeSample = Contribution & { label: string; sql: string };

/** What a plugin can do to the Code page. Acquire it with codePageApi(ctx) in your plugin's activate(). */
export type CodePageApi = {
  /** Render result cells produced by render('<renderer.id>', ...args). */
  registerRenderer(renderer: CellRenderer): Disposable;
  /** Register SQL functions usable in queries (auto-namespaced by plugin id, e.g. torah_code_find). */
  registerFns(specs: SqlFnSpec[]): Promise<void>;
  /** Add a query to the sample dropdown. */
  registerSample(sample: CodeSample): Disposable;
};

export function codePageApi(ctx: PluginContext): CodePageApi {
  return {
    registerRenderer: (renderer) => ctx.contribute(CODE_PAGE_ID, 'cellRenderer', renderer),
    registerFns: (specs) => ctx.data.defineFunctions(specs),
    registerSample: (sample) => ctx.contribute(CODE_PAGE_ID, 'sample', sample),
  };
}
