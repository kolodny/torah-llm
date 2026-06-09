// Fetch each enabled source's subset into its local cache (idempotent). Adapters own their own
// fetch logic (URLs, layout). Run via `npm run fetch:subset`.

import { adapters } from './sources/index.ts';

console.log(`Fetching subsets for ${adapters.length} source(s)…`);
for (const adapter of adapters) {
  await adapter.fetchSubset();
}
console.log('Done.');
