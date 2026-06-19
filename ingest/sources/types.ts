// A source adapter fetches a corpus's raw files and emits rows in the common shape. The catalog
// is CANONICAL (books keyed by title, source-independent); each source contributes one or more
// EDITIONS (a version of a book's text in some language) plus the content for each edition.

export type TocInsert = {
  id: string; // canonical: a book title or a category path
  parent_id: string | null;
  kind: 'category' | 'book';
  title_en: string | null;
  title_he: string | null;
  category_en: string | null;
  category_he: string | null;
  order_index: number | null;
};

export type EditionInsert = {
  id: string; // e.g. 'sefaria:Genesis:en:JPS 1917'
  tocId: string; // canonical book id (= title)
  source: string; // 'sefaria' | 'oshb' | 'orayta'
  lang: string; // 'he' | 'en' | 'fr' | …
  title: string; // short display name
  info: string | null; // provenance (version title / source / license), shown on hover
  orderIndex: number;
};

export interface IngestCtx {
  /** A canonical catalog node. INSERT OR IGNORE — the first source to define a node wins. */
  toc(row: TocInsert): void;
  /**
   * Place a Sefaria-absent work by grafting onto an EXISTING category branch. `path` is the full
   * category chain (e.g. ['Tanakh','Modern Commentary on Tanakh','Biur']); ids are the ' / '-joined
   * segments, matching Sefaria's spine. Returns the leaf id to use as the book's parent_id.
   *
   * Rules (these are what keep placement honest): the leaf may be new, but its PARENT must already
   * exist — so Sefaria (ingested first) owns the branch you hang off. A new TOP-LEVEL root is refused;
   * declare those once in build-master's HOUSE_CATEGORIES. We trust Sefaria's categories implicitly;
   * ours are explicit.
   */
  category(path: string[], opts?: { he?: string | null; order?: number }): string;
  edition(row: EditionInsert): void;
  content(row: { editionId: string; tocId: string; ref: string; text: string }): void;
  meta(row: { tocId: string; schema: unknown }): void;
  link(row: {
    fromId: string;
    fromRef: string;
    toId: string;
    toRef: string;
    connectionType: string;
  }): void;
}

export interface SourceAdapter {
  id: string;
  name: string;
  fetchSubset(): Promise<void>;
  ingest(ctx: IngestCtx): void;
}
