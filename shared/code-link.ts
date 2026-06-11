// A sentinel-tagged string emitted by the SQL link(book, ref [, label]) function and decoded by the
// Code page's results table, which renders it as a link that opens the viewer at book + ref.
// The tag uses U+0001 (SOH): non-NUL, so SQLite TEXT won't truncate it, and it never appears in real text.
const SOH = String.fromCharCode(1);
export const LINK_TAG = SOH + 'link' + SOH;

export type CodeLink = { book: string; ref: string | null; label: string };

export function encodeLink(l: CodeLink): string {
  return LINK_TAG + JSON.stringify(l);
}

export function decodeLink(v: unknown): CodeLink | null {
  if (typeof v !== 'string' || !v.startsWith(LINK_TAG)) return null;
  try {
    return JSON.parse(v.slice(LINK_TAG.length)) as CodeLink;
  } catch {
    return null;
  }
}
