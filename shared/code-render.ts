// A sentinel-tagged string emitted by the SQL render(rendererId, ...args) function and decoded by the Code
// page's results table, which hands the args to a plugin-contributed cell renderer (the `cellRenderer` slot
// on the code-search page). Uses U+0002 (STX): non-NUL, so SQLite TEXT won't truncate it.
const STX = String.fromCharCode(2);
export const RENDER_TAG = STX + 'render' + STX;

export type CodeRender = { type: string; args: unknown[] };

export function encodeRender(r: CodeRender): string {
  return RENDER_TAG + JSON.stringify(r);
}

export function decodeRender(v: unknown): CodeRender | null {
  if (typeof v !== 'string' || !v.startsWith(RENDER_TAG)) return null;
  try {
    return JSON.parse(v.slice(RENDER_TAG.length)) as CodeRender;
  } catch {
    return null;
  }
}
