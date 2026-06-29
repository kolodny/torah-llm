// The Code page's extension API. The code-search plugin PUBLISHES the codePageApi factory via
// ctx.exposeApi(CODE_PAGE_ID, codePageApi); other plugins acquire it with
// ctx.getApi<CodePageApiFactory>(CODE_PAGE_ID)?.(ctx) and only type-import from here (no module coupling).
// The page owns the contract (slot names + types); core stays generic (contribute()/useSlot()/data). Any page
// can follow this pattern: a `<page>Api(ctx)` factory + its contribution types, exposed under a name.
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

/** The shape published under getApi(CODE_PAGE_ID): call it with YOUR ctx to extend the Code page. */
export type CodePageApiFactory = (ctx: PluginContext) => CodePageApi;

export function codePageApi(ctx: PluginContext): CodePageApi {
  return {
    registerRenderer: (renderer) => ctx.contribute(CODE_PAGE_ID, 'cellRenderer', renderer),
    registerFns: (specs) => ctx.data.defineFunctions(specs),
    registerSample: (sample) => ctx.contribute(CODE_PAGE_ID, 'sample', sample),
  };
}
