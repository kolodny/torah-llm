// The workbench store — the single place the app's navigation + UI intent lives, exposed as
// { state, dispatch, toast } via useWorkbench(). It is the keystone of the plugin platform: core and
// plugins read the same state and drive it through one dispatch, instead of prop-drilling and each
// component reaching into the router.
//
// URL-backed fields (book / ref / ed / peek / pr) are DERIVED from the router's search params, so a
// <Link>, the Back button, and a hand-edited URL all flow into the same state with no manual sync.
// Ephemeral UI (the open sidebar panel, the current selection, a transient toast) lives in a local
// reducer. dispatch() is the programmatic entry point used by buttons today and by plugins/panes later.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router';

// Selected editions are repeated `?ed=` params; this separator only joins them into a memo key.
const ED_KEY_SEP = '\x1f';

/** A text selection a plugin can read/drive. Only `null` is used in phase 1; richer kinds come later. */
export type Selection = null | { type: 'segment'; book: string; ref: string };

/** The unified workbench state consumers read. */
export type WorkbenchState = {
  page: string; // the active top-level page (header nav): 'viewer' | 'storage' | a plugin page id
  book: string | null; // the book open in the main reader
  ref: string | null; // the focused ref within it, if any
  selectedEditionIds: string[]; // the edition columns shown, in order
  peek: { book: string; ref: string | null } | null; // the inline-preview target, if open
  sidebarPanelId: string | null; // the open right-rail panel, if any
  editorId: string | null; // the chosen main-view editor (null = auto-pick highest canRender)
  selection: Selection; // current text selection (for plugins)
};

/** Everything that mutates the workbench goes through one of these. */
export type WorkbenchAction =
  | { type: 'setPage'; id: string } // switch the active top-level page (header nav)
  | { type: 'navigate'; book: string; ref?: string | null } // open a book in the reader (clears peek)
  | { type: 'setEditions'; ids: string[] } // set the shown edition columns (order matters)
  | { type: 'peek'; book: string; ref: string | null } // open the inline preview
  | { type: 'clearPeek' }
  | { type: 'openPanel'; id: string } // open a right-rail panel
  | { type: 'closePanel' }
  | { type: 'setEditor'; id: string | null } // choose the main-view editor (null = auto)
  | { type: 'setSelection'; selection: Selection }
  | { type: 'toast'; message: string | null };

// --- local (non-URL) state --------------------------------------------------------------------
type LocalState = { sidebarPanelId: string | null; editorId: string | null; selection: Selection; toast: string | null };
const initialLocal: LocalState = { sidebarPanelId: null, editorId: null, selection: null, toast: null };

function localReducer(s: LocalState, a: WorkbenchAction): LocalState {
  switch (a.type) {
    case 'openPanel':
      return { ...s, sidebarPanelId: a.id };
    case 'closePanel':
      return { ...s, sidebarPanelId: null };
    case 'setEditor':
      return { ...s, editorId: a.id };
    case 'setSelection':
      return { ...s, selection: a.selection };
    case 'toast':
      return { ...s, toast: a.message };
    default:
      return s; // URL-backed actions are handled by the dispatch facade, not here
  }
}

type WorkbenchCtx = {
  state: WorkbenchState;
  dispatch: (action: WorkbenchAction) => void;
  toast: string | null;
};
const Ctx = createContext<WorkbenchCtx | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const [local, localDispatch] = useReducer(localReducer, initialLocal);

  // dispatch facade: URL-backed actions write the router params (so they're shareable + Back-able);
  // everything else goes to the local reducer.
  const dispatch = useCallback(
    (action: WorkbenchAction) => {
      switch (action.type) {
        case 'setPage':
          setParams((prev) => {
            const p = new URLSearchParams(prev);
            p.set('page', action.id);
            return p;
          });
          break;
        case 'navigate':
          setParams((prev) => {
            const p = new URLSearchParams(prev);
            p.set('page', 'viewer'); // the reader lives on the viewer page — opening a book shows it there
            p.set('book', action.book);
            if (action.ref) p.set('ref', action.ref);
            else p.delete('ref');
            p.delete('peek'); // opening a book dismisses any inline preview
            p.delete('pr');
            return p;
          });
          break;
        case 'setEditions':
          setParams(
            (prev) => {
              const p = new URLSearchParams(prev);
              p.delete('ed');
              action.ids.forEach((id) => p.append('ed', id));
              return p;
            },
            { replace: true } // reordering columns shouldn't add history entries
          );
          break;
        case 'peek':
          setParams((prev) => {
            const p = new URLSearchParams(prev);
            p.set('peek', action.book);
            if (action.ref) p.set('pr', action.ref);
            else p.delete('pr');
            return p;
          });
          break;
        case 'clearPeek':
          setParams((prev) => {
            const p = new URLSearchParams(prev);
            p.delete('peek');
            p.delete('pr');
            return p;
          });
          break;
        default:
          localDispatch(action);
      }
    },
    [setParams]
  );

  const page = params.get('page') ?? 'viewer';
  const book = params.get('book');
  const ref = params.get('ref');
  const edKey = params.getAll('ed').join(ED_KEY_SEP);
  const peekBook = params.get('peek');
  const peekRef = params.get('pr');

  const state = useMemo<WorkbenchState>(
    () => ({
      page,
      book,
      ref,
      selectedEditionIds: edKey ? edKey.split(ED_KEY_SEP) : [],
      peek: peekBook ? { book: peekBook, ref: peekRef } : null,
      sidebarPanelId: local.sidebarPanelId,
      editorId: local.editorId,
      selection: local.selection,
    }),
    [page, book, ref, edKey, peekBook, peekRef, local.sidebarPanelId, local.editorId, local.selection]
  );

  // Auto-dismiss a toast a few seconds after it's set.
  useEffect(() => {
    if (local.toast == null) return;
    const t = setTimeout(() => localDispatch({ type: 'toast', message: null }), 3000);
    return () => clearTimeout(t);
  }, [local.toast]);

  const value = useMemo<WorkbenchCtx>(
    () => ({ state, dispatch, toast: local.toast }),
    [state, dispatch, local.toast]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkbench(): WorkbenchCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkbench must be used within <WorkbenchProvider>');
  return v;
}
