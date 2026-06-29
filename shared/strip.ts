// Turn stored HTML into clean text: remove tags AND decode HTML entities. Sefaria text contains things
// like "&thinsp;" and "&nbsp;" that a tag-only strip leaves visible. Runs in the worker (no DOM), so the
// entity table is explicit; numeric (&#NNNN; / &#xHHHH;) entities are decoded generically.
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', thinsp: ' ', ensp: ' ', emsp: ' ', hairsp: ' ', shy: '',
  zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', ndash: '–', mdash: '—', middot: '·', deg: '°',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const r = ENTITIES[body.toLowerCase()];
    return r !== undefined ? r : m;
  });
}

/** Remove HTML tags and decode entities — e.g. "<b>אֱלֹהִים&thinsp;׀</b>" -> "אֱלֹהִים ׀". */
// Sefaria "Miqra according to the Masorah" parsha-break markers — <span class="mam-spi-pe">{פ}</span>
// (petucha) and <span class="mam-spi-samekh">{ס}</span> (setuma) — are editorial spacing annotations, not part
// of the verse. Drop the whole span *including* its bracketed letter, so the plain-text projection (and
// everything built on it: strip()/words()/letters()/gematria) never reads the פ/ס as a real letter — e.g.
// without this, Psalms 24:10 ("…סֶלָה׃ {פ}") looks like it ends in פ. Ketiv/qere spans (mam-kq*) carry real
// text and are intentionally left for the generic tag-strip below to unwrap.
export const MAM_SPI_SPAN = /<span\b[^>]*\bmam-spi[^>]*>[^<]*<\/span>/gi;

export function stripHtml(v: unknown): string {
  return decodeEntities(
    String(v ?? '')
      .replace(MAM_SPI_SPAN, '')
      .replace(/<[^>]+>/g, '')
  );
}
