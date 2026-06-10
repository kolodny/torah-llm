// Row shapes for the browser DB queries. Mirror shared/schema.ts (canonical books + editions).

export type TocRow = {
  id: string;
  parent_id: string | null;
  kind: 'category' | 'book';
  title_en: string | null;
  title_he: string | null;
  category_en: string | null;
  category_he: string | null;
  order_index: number | null;
  has_content: number; // 0 | 1
  edition_count: number;
  file_size: number | null;
};

/** A version of a book's text in some language/source (e.g. "JPS 1917", "WLC"). */
export type Edition = {
  id: string;
  toc_id: string;
  source: string;
  lang: string; // 'he' | 'en' | 'fr' | …
  title: string;
  info: string | null; // provenance, shown on chip hover
  order_index: number | null;
};

export type ContentRow = {
  edition_id: string;
  ref: string;
  text: string;
};

/** A link from the current book's ref to content in another (possibly not-yet-local) book. */
export type LinkRef = {
  otherId: string;
  otherRef: string;
  connectionType: string | null;
};

export type Progress = { received: number; total: number };
