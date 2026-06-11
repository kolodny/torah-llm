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
export function stripHtml(v: unknown): string {
  return decodeEntities(String(v ?? '').replace(/<[^>]+>/g, ''));
}
