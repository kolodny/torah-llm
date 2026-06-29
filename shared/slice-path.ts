// Stable mapping from a TOC id to its slice filename. Shared by the slicer (which writes the
// files) and the browser client (which fetches them) so the two sides can never disagree.
//
// ids are namespaced and may contain ':' '/' and spaces (e.g. 'sefaria:Rashi on Genesis').
//   sliceFileName : on-disk name. encodeURIComponent makes it injective and filesystem-safe
//                   (no ':' or '/', which macOS mangles) — special chars become %XX literally.
//   sliceUrlPath  : encoded AGAIN, used for the fetch URL and OPFS path, so the dev server
//                   decodes it exactly back to sliceFileName (and it has no spaces for OPFS).

export const TOC_DB = 'db.sqlite'; // the toc-only DB the app boots from

// Deterministic 64-bit hex hash, identical in Node and the browser (pure JS, sync) — used for ids
// whose percent-encoded filename would exceed the filesystem limit (deeply-nested complex texts).
function hashId(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// Readable slice filename: the TOC id with non-alphanumeric runs collapsed to '_' and trimmed, e.g.
//   'A Jewish Critique of the Philosophy of Martin Buber, Postscript'
//     -> 'A_Jewish_Critique_of_the_Philosophy_of_Martin_Buber_Postscript_<hash>.sqlite'
// The trailing 8-hex of the 53-bit id hash keeps it UNIQUE: some ids slug identically (e.g. two that differ
// only by a trailing '*'), which would otherwise collide and silently drop a book. The hash only has to
// separate same-slug ids (tiny groups), so 8 hex is ample. Pure + deterministic + ASCII-only ([A-Za-z0-9_.]),
// so the slicer and client always agree and no URL re-encoding is needed (kills the old %-double-encoding).
export function sliceFileName(tocId: string): string {
  const slug = tocId.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180);
  return `${slug}_${hashId(tocId).slice(0, 8)}.sqlite`;
}

export function sliceUrlPath(tocId: string): string {
  return sliceFileName(tocId); // already filesystem/URL-safe — no encodeURIComponent needed
}
