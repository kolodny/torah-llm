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
// Editorial / annotation ELEMENTS whose CONTENT is not part of the source text — dropped element-and-all, so
// the plain-text projection (and everything built on it: strip()/words()/letters()/gematria/torah codes) never
// reads their letters. Determined by auditing the whole corpus's markup (ingest/scan-html.mjs):
//   • <sup class="footnote-marker">*</sup> + <i class="footnote">…</i> — the by-far most common annotation
//     (~385k each): translator/masoretic notes (e.g. "בספרי ספרד ואשכנז …"), NOT the text. Footnote bodies can
//     nest tags (<big>…), so match lazily to the element's own close.
//   • <span class="mam-spi-…">{פ}/{ס}</span> — "Miqra according to the Masorah" parsha-break markers (petucha/
//     setuma); without this Psalms 24:10 ("…סֶלָה׃ {פ}") looks like it ends in פ.
// Everything else (b/i/small/sup/big/strong/em, span.poetry/refLink/font…, and mam-kq* ketiv/qere — which IS
// real text) just gets unwrapped by the generic tag-strip below, keeping its content.
export const MAM_SPI_SPAN = /<span\b[^>]*\bmam-spi[^>]*>[^<]*<\/span>/gi;
const FOOTNOTE_MARKER = /<sup\b[^>]*\bfootnote-marker\b[^>]*>[\s\S]*?<\/sup>/gi;
const FOOTNOTE = /<i\b[^>]*\bfootnote\b[^>]*>[\s\S]*?<\/i>/gi;

export function stripHtml(v: unknown): string {
  return decodeEntities(
    String(v ?? '')
      .replace(FOOTNOTE_MARKER, '')
      .replace(FOOTNOTE, '')
      .replace(MAM_SPI_SPAN, '')
      .replace(/<[^>]+>/g, '')
  );
}
