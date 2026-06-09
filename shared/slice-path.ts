// Stable mapping from a TOC id to its slice filename. Shared by the slicer (which writes the
// files) and the browser client (which fetches them) so the two sides can never disagree.
//
// ids are namespaced and may contain ':' '/' and spaces (e.g. 'sefaria:Rashi on Genesis').
//   sliceFileName : on-disk name. encodeURIComponent makes it injective and filesystem-safe
//                   (no ':' or '/', which macOS mangles) — special chars become %XX literally.
//   sliceUrlPath  : encoded AGAIN, used for the fetch URL and OPFS path, so the dev server
//                   decodes it exactly back to sliceFileName (and it has no spaces for OPFS).

export const TOC_DB = 'db.sqlite'; // the toc-only DB the app boots from

export function sliceFileName(tocId: string): string {
  return `toc_${encodeURIComponent(tocId)}.sqlite`;
}

export function sliceUrlPath(tocId: string): string {
  return encodeURIComponent(sliceFileName(tocId));
}
