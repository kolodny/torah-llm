// Pinned source versions, read from the committed sources.lock.json. Adapters fetch from these
// refs so a clone builds the same data without committing the corpora (see .gitignore).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Pin = { type: string; repo?: string; ref?: string; bucket?: string };
const lock = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../sources.lock.json'), 'utf8')
) as { sources: Record<string, Pin> };

export const pins = lock.sources;

/** Raw GitHub URL base for a github-raw source, pinned to its ref. */
export function githubRawBase(sourceId: string): string {
  const p = pins[sourceId];
  if (!p?.repo || !p?.ref) throw new Error(`No github-raw pin for source '${sourceId}'`);
  return `https://raw.githubusercontent.com/${p.repo}/${p.ref}`;
}
