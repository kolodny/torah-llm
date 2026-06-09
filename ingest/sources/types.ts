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
