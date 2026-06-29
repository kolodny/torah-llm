// Sample the annotation-markup structures so we can write a correct stripHtml.
import D from 'better-sqlite3';
const db = new D('data/master.sqlite', { readonly: true });
const sample = (like, n = 3) => db.prepare(`SELECT toc_id, ref, text FROM content WHERE text LIKE ? LIMIT ${n}`).all(`%${like}%`);
const show = (label, like) => {
  console.log(`\n===== ${label} =====`);
  for (const r of sample(like)) {
    // print a window around the marker
    const i = r.text.indexOf(like.replace(/%/g, ''));
    console.log(`${r.toc_id} ${r.ref}:`);
    console.log('  …' + r.text.slice(Math.max(0, i - 40), i + 160).replace(/\n/g, ' ') + '…');
  }
};
show('footnote-marker', 'footnote-marker');
show('footnote (i)', 'class="footnote"');
show('refLink', 'refLink');
show('mam-spi-pe', 'mam-spi-pe');
show('mam-kq', 'mam-kq');
// does a he Tanakh verse ever carry a footnote? (affects letters/gematria of the core text)
const heFn = db.prepare(`SELECT count(*) n FROM content c JOIN editions e ON e.id=c.edition_id JOIN toc t ON t.id=c.toc_id WHERE e.lang='he' AND t.parent_id IN ('Tanakh / Torah','Tanakh / Prophets','Tanakh / Writings') AND c.text LIKE '%footnote%'`).get().n;
console.log('\nHe Tanakh verses with a footnote:', heFn);
// do footnotes nest other tags inside? sample one footnote's inner html
const one = db.prepare(`SELECT text FROM content WHERE text LIKE '%class="footnote"%' LIMIT 1`).get();
console.log('\nfootnote inner sample:', one ? one.text.slice(one.text.indexOf('class="footnote"'), one.text.indexOf('class="footnote"') + 220) : '(none)');
