import type { SourceAdapter } from './types.ts';
import { sefaria } from './sefaria.ts';
import { oshb } from './oshb.ts';
import { orayta } from './orayta.ts';

// Enabled sources, ingested in order. Add new corpora here.
export const adapters: SourceAdapter[] = [sefaria, oshb, orayta];
