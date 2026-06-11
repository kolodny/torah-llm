// A reusable nested checkbox tree over the catalog (categories → books), with cascading select + indeterminate
// parents. Used by the Storage page (download/clear) and by plugins (e.g. Gematria's "search which books").
import { useMemo, type ReactNode } from 'react';
import { Tree, useTree, type TreeNodeData, Checkbox, Group, Text } from '@mantine/core';
import type { TocRow } from '../db/types';

export type CatalogNode = TocRow & { children: CatalogNode[] };

export function buildTree(rows: TocRow[]): CatalogNode[] {
  const byId = new Map<string, CatalogNode>();
  rows.forEach((r) => byId.set(r.id, { ...r, children: [] }));
  const roots: CatalogNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const cmp = (a: CatalogNode, b: CatalogNode) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id.localeCompare(b.id);
  const sortRec = (nodes: CatalogNode[]) => {
    nodes.sort(cmp);
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

export const fmtBytes = (n: number | null) => {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export function BookCheckTree({
  toc,
  checked,
  onChange,
  renderBookExtra,
}: {
  toc: TocRow[];
  checked: Set<string>;
  onChange: (next: Set<string>) => void;
  renderBookExtra?: (bookId: string, row: TocRow) => ReactNode;
}) {
  const tree = useTree();
  const roots = useMemo(() => buildTree(toc), [toc]);
  const byId = useMemo(() => new Map(toc.map((t) => [t.id, t] as const)), [toc]);

  // For each node, the book ids beneath it (a book maps to itself) — drives the cascade + indeterminate state.
  const bookDescendants = useMemo(() => {
    const m = new Map<string, string[]>();
    const walk = (n: CatalogNode): string[] => {
      const books = n.kind === 'book' ? [n.id] : n.children.flatMap(walk);
      m.set(n.id, books);
      return books;
    };
    roots.forEach(walk);
    return m;
  }, [roots]);

  const data = useMemo<TreeNodeData[]>(() => {
    const toData = (n: CatalogNode): TreeNodeData => ({ value: n.id, label: n.kind === 'book' ? n.title_en : n.category_en, children: n.children.length ? n.children.map(toData) : undefined });
    return roots.map(toData);
  }, [roots]);

  const isChecked = (value: string) => {
    const b = bookDescendants.get(value) ?? [];
    return b.length > 0 && b.every((x) => checked.has(x));
  };
  const isIndeterminate = (value: string) => {
    const b = bookDescendants.get(value) ?? [];
    const n = b.filter((x) => checked.has(x)).length;
    return n > 0 && n < b.length;
  };
  const toggle = (value: string) => {
    const books = bookDescendants.get(value) ?? [];
    const next = new Set(checked);
    const allOn = books.every((b) => next.has(b));
    for (const b of books) if (allOn) next.delete(b); else next.add(b);
    onChange(next);
  };

  return (
    <Tree
      data={data}
      tree={tree}
      levelOffset={20}
      renderNode={({ node, expanded, hasChildren, elementProps, level }) => {
        const row = byId.get(node.value);
        const isBook = row?.kind === 'book';
        return (
          <Group gap={6} wrap="nowrap" {...elementProps} style={{ ...elementProps.style, paddingLeft: (level - 1) * 20, paddingTop: 3, paddingBottom: 3 }}>
            <span style={{ width: 14, textAlign: 'center', color: 'var(--mantine-color-orange-7)' }}>{hasChildren ? (expanded ? '▾' : '▸') : ''}</span>
            <Checkbox
              size="xs"
              checked={isChecked(node.value)}
              indeterminate={isIndeterminate(node.value)}
              onChange={() => toggle(node.value)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${node.label}`}
            />
            <Text size="sm" style={{ flex: 1, fontWeight: isBook ? 400 : 600 }}>
              {node.label}
              {hasChildren && row?.kind === 'category' && <Text span c="dimmed" size="xs"> · {bookDescendants.get(node.value)?.length ?? 0}</Text>}
            </Text>
            {isBook && row && renderBookExtra?.(node.value, row)}
          </Group>
        );
      }}
    />
  );
}
