import type { SourceAdapter } from './types.ts';
import { sefaria } from './sefaria.ts';
import { orayta } from './orayta.ts';
import { opensiddur } from './opensiddur.ts';

// Enabled sources, ingested in order. Add new corpora here. Jewish-origin sources only.
export const adapters: SourceAdapter[] = [sefaria, orayta, opensiddur];
