// SegmentText renders one text segment with plugin decorations applied. It is the single sink for
// corpus HTML — every reader view (grid, standalone, peek) goes through it, so decorations work
// everywhere and the HTML is sanitized (DOMPurify) in one place.
//
// `mark` decorations highlight a plaintext range (offsets index the tag-stripped text); decorateHtml
// splices <mark> spans into the HTML at those offsets, preserving the existing tags. `lineWidget`
// decorations render React nodes above the segment (e.g. a note pin). Mark clicks are delegated.
import { useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { useSlot, useDecorationsTick } from '../plugins/host';
import type { Decoration, DecorationProvider, Segment } from '../plugins/types';
import { MAM_SPI_SPAN } from '../../shared/strip';

type Mark = Extract<Decoration, { kind: 'mark' }>;
type LineWidget = Extract<Decoration, { kind: 'lineWidget' }>;

// Plaintext basis for decoration offsets. Tag-only (entities stay raw, so offsets mirror the char-by-char
// walk in decorateHtml — NOT shared stripHtml, which decodes entities and would desync). Mesorah parsha-break
// markers (<span class="mam-spi-…">{פ}</span>) are dropped here AND skipped as zero-width in decorateHtml, so
// seg.text stays clean (no stray {פ}/{ס} for plugin analysis) while the two remain offset-consistent.
const stripTags = (html: string) => html.replace(MAM_SPI_SPAN, '').replace(/<[^>]+>/g, '');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Sanitize once; keep data-deco (mark click delegation) + dir/class/the refLink data-ref the reader uses.
const sanitize = (html: string) => DOMPurify.sanitize(html, { ADD_ATTR: ['data-ref', 'data-deco', 'target'] });

/** Insert <mark> spans at plaintext offsets in an HTML string, preserving existing tags. Offsets index
 *  the tag-stripped text; each mark carries data-deco=<index> for click delegation. A range crossing a
 *  tag boundary is uncommon for word highlights, and DOMPurify normalizes any resulting nesting. */
export function decorateHtml(html: string, marks: Mark[]): string {
  if (!marks.length) return html;
  const plainLen = stripTags(html).length; // clamp offsets so an out-of-range `to` can't leave a <mark> unclosed
  const opensAt = new Map<number, string[]>();
  const closesAt = new Map<number, string[]>();
  marks.forEach((m, i) => {
    const from = Math.max(0, Math.min(m.from, plainLen));
    const to = Math.max(from, Math.min(m.to, plainLen));
    if (to <= from) return; // skip empty / out-of-range ranges
    const open = `<mark class="${escapeAttr(m.className ?? 'deco-mark')}" data-deco="${i}"${
      m.title ? ` title="${escapeAttr(m.title)}"` : ''
    }>`;
    (opensAt.get(from) ?? opensAt.set(from, []).get(from)!).push(open);
    (closesAt.get(to) ?? closesAt.set(to, []).get(to)!).push('</mark>');
  });
  let out = '';
  let plain = 0;
  let i = 0;
  const flush = (offset: number) => {
    if (closesAt.has(offset)) out += closesAt.get(offset)!.join('');
    if (opensAt.has(offset)) out += opensAt.get(offset)!.join('');
  };
  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      const stop = end === -1 ? html.length : end + 1;
      // Parsha-break marker span: render verbatim but contribute no plaintext (matches stripTags, which
      // drops it) so offsets after it stay aligned.
      if (/^<span\b[^>]*\bmam-spi/i.test(html.slice(i, stop))) {
        const close = html.indexOf('</span>', stop);
        const spanEnd = close === -1 ? stop : close + 7;
        out += html.slice(i, spanEnd);
        i = spanEnd;
        continue;
      }
      out += html.slice(i, stop); // copy the whole tag verbatim (doesn't advance plaintext offset)
      i = stop;
    } else {
      flush(plain);
      out += html[i];
      i += 1;
      plain += 1;
    }
  }
  flush(plain); // marks closing at end-of-text
  return out;
}

export function SegmentText({
  book,
  segRef,
  editionId,
  lang,
  html,
  className,
  dir,
  primary = true,
}: {
  book: string;
  segRef: string;
  editionId: string;
  lang: string;
  html: string;
  className: string;
  dir: 'rtl' | 'ltr';
  /** True for the FIRST column rendering this ref (default). Per-ref decorations (e.g. note pins) gate on
   *  this so they render once per verse instead of once per edition column / tied to the volatile selection. */
  primary?: boolean;
}) {
  const decorationProviders = useSlot<DecorationProvider>('viewer', 'decoration');
  const tick = useDecorationsTick();
  const seg = useMemo<Segment>(
    () => ({ book, ref: segRef, editionId, lang, html, text: stripTags(html), primary }),
    [book, segRef, editionId, lang, html, primary]
  );
  const decos = useMemo(
    () =>
      decorationProviders.flatMap((p) => {
        try {
          return p.provide(seg);
        } catch (e) {
          console.error(`[decorations] provider "${p.id}" failed:`, e);
          return [];
        }
      }),
    // tick forces re-decoration when a provider signals 'decorations.changed'
    [seg, decorationProviders, tick]
  );
  const marks = useMemo(() => decos.filter((d): d is Mark => d.kind === 'mark'), [decos]);
  const lineWidgets = useMemo(() => decos.filter((d): d is LineWidget => d.kind === 'lineWidget'), [decos]);
  const __html = useMemo(() => sanitize(decorateHtml(html, marks)), [html, marks]);

  const onClick = marks.some((m) => m.onClick)
    ? (e: ReactMouseEvent<HTMLParagraphElement>) => {
        const el = (e.target as HTMLElement).closest('mark[data-deco]') as HTMLElement | null;
        if (el) marks[Number(el.dataset.deco)]?.onClick?.(e.nativeEvent, seg);
      }
    : undefined;

  const p = <p className={className} dir={dir} onClick={onClick} dangerouslySetInnerHTML={{ __html }} />;
  if (!lineWidgets.length) return p;
  return (
    <div className="segment">
      {lineWidgets.map((w, i) => (
        <div key={i} className="deco-line">
          {w.render(seg)}
        </div>
      ))}
      {p}
    </div>
  );
}
