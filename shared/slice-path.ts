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

export function sliceFileName(tocId: string): string {
  const enc = encodeURIComponent(tocId);
  // Filenames cap at 255 bytes; a long/encoded id (e.g. a deeply-nested complex-text sub-book) can
  // blow past that → fall back to a hash. Deterministic + shared, so slicer and client agree.
  return enc.length <= 200 ? `toc_${enc}.sqlite` : `toc_h${hashId(tocId)}.sqlite`;
}

export function sliceUrlPath(tocId: string): string {
  return encodeURIComponent(sliceFileName(tocId));
}
