// Main-thread interface to the shared SQLite worker.
//
// Sharing across tabs: a Broker SharedWorker plus the Web Locks API elect ONE leader tab. The
// leader spawns the single dedicated db worker (which owns the OPFS SAH pool) and, on request,
// mints a MessagePort to it for each tab. Every tab talks to that one worker, so all tabs share
// one connection + one set of downloaded books. On leader handoff the broker tells tabs to
// reconnect.

import { wrap, proxy } from 'comlink';
import type { Remote } from 'comlink';
import type { Api } from './worker';
import type { TocRow, Edition, ContentRow, LinkRef, Progress } from './types';
import { sliceUrlPath, TOC_DB } from '../../shared/slice-path';

const base = import.meta.env.BASE_URL; // '/' in dev
const bootUrl = `${base}db/${TOC_DB}`;

let brokerPort: MessagePort | null = null;
let apiPromise: Promise<Remote<Api>> | null = null;
const portWaiters: Array<(p: MessagePort) => void> = [];

function acquire(): Promise<Remote<Api>> {
  const port = new Promise<MessagePort>((resolve, reject) => {
    const waiter = (p: MessagePort) => {
      clearTimeout(timer);
      resolve(p);
    };
    const timer = setTimeout(() => {
      const i = portWaiters.indexOf(waiter);
      if (i >= 0) portWaiters.splice(i, 1);
      reject(
        new Error(
          'Could not reach the database worker. Close other tabs of this app and reload, or use "Wipe local DB".'
        )
      );
    }, 15000);
    portWaiters.push(waiter);
    brokerPort!.postMessage({ type: 'want' });
  });
  return port.then((p) => {
    p.start();
    return wrap<Api>(p);
  });
}

function ensureStarted() {
  if (apiPromise) return;

  const broker = new SharedWorker(new URL('./broker.ts', import.meta.url), { type: 'module' });
  brokerPort = broker.port;
  brokerPort.onmessage = (e: MessageEvent) => {
    if (e.data?.type === 'worker-port') {
      portWaiters.shift()?.(e.data.port as MessagePort);
    } else if (e.data?.type === 'leader-changed') {
      apiPromise = acquire();
    }
  };
  brokerPort.start();

  apiPromise = acquire();

  void navigator.locks.request('torah-leader', { mode: 'exclusive' }, () =>
    new Promise<never>(() => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const control = new MessageChannel();
      control.port1.onmessage = (e: MessageEvent) => {
        if (e.data?.type === 'mint') {
          const wc = new MessageChannel();
          worker.postMessage({ type: 'connect', port: wc.port2 }, [wc.port2]);
          control.port1.postMessage({ type: 'minted', id: e.data.id, port: wc.port1 }, [wc.port1]);
        }
      };
      control.port1.start();
      brokerPort!.postMessage({ type: 'leader', control: control.port2 }, [control.port2]);
      // never resolves → holds the leader lock until this tab closes
    })
  );
}

async function withApi<T>(fn: (api: Remote<Api>) => Promise<T>): Promise<T> {
  ensureStarted();
  const api = await apiPromise!;
  try {
    return await fn(api);
  } catch (e) {
    const next = await apiPromise!;
    if (next !== api) return fn(next);
    throw e;
  }
}

export async function sqliteVersion(): Promise<string> {
  return withApi((api) => api.version());
}

export async function getToc(): Promise<TocRow[]> {
  return withApi(async (api) => (await api.exec('SELECT * FROM toc')) as unknown as TocRow[]);
}

/** Canonical book ids whose content is already in the local DB. */
export async function getLocalBookIds(): Promise<string[]> {
  return withApi(async (api) =>
    ((await api.exec('SELECT DISTINCT toc_id AS id FROM content')) as unknown as { id: string }[]).map(
      (r) => r.id
    )
  );
}

export async function getEditions(tocId: string): Promise<Edition[]> {
  return withApi(
    async (api) =>
      (await api.exec(
        'SELECT id, toc_id, source, lang, title, order_index FROM editions WHERE toc_id = ? ORDER BY order_index, lang',
        [tocId]
      )) as unknown as Edition[]
  );
}

/** All content rows (every edition) for a book. */
export async function getContent(tocId: string): Promise<ContentRow[]> {
  return withApi(
    async (api) =>
      (await api.exec('SELECT edition_id, ref, text FROM content WHERE toc_id = ? ORDER BY id', [
        tocId,
      ])) as unknown as ContentRow[]
  );
}

export async function getLinks(tocId: string): Promise<Record<string, LinkRef[]>> {
  return withApi(async (api) => {
    const rows = (await api.exec(
      `SELECT from_id, from_ref, to_id, to_ref, connection_type
         FROM links WHERE from_id = ? OR to_id = ?`,
      [tocId, tocId]
    )) as unknown as {
      from_id: string;
      from_ref: string;
      to_id: string;
      to_ref: string;
      connection_type: string | null;
    }[];
    const map: Record<string, LinkRef[]> = {};
    for (const r of rows) {
      const isFrom = r.from_id === tocId;
      const thisRef = isFrom ? r.from_ref : r.to_ref;
      (map[thisRef] ??= []).push({
        otherId: isFrom ? r.to_id : r.from_id,
        otherRef: isFrom ? r.to_ref : r.from_ref,
        connectionType: r.connection_type,
      });
    }
    return map;
  });
}

export async function downloadBook(tocId: string, onProgress?: (p: Progress) => void) {
  const name = sliceUrlPath(tocId);
  await withApi((api) =>
    api.merge(`${base}db/${name}`, `/${name}`, onProgress ? proxy(onProgress) : undefined)
  );
}

/** Ensure a book's content is local, downloading its slice once if needed (dedupes concurrent calls). */
const ensuring = new Map<string, Promise<void>>();
export function ensureBook(tocId: string, onProgress?: (p: Progress) => void): Promise<void> {
  let p = ensuring.get(tocId);
  if (!p) {
    const name = sliceUrlPath(tocId);
    p = withApi(async (api) => {
      const has =
        ((await api.exec('SELECT 1 FROM content WHERE toc_id = ? LIMIT 1', [tocId])) as unknown as unknown[])
          .length > 0;
      if (!has) {
        await api.merge(`${base}db/${name}`, `/${name}`, onProgress ? proxy(onProgress) : undefined);
      }
    });
    ensuring.set(tocId, p);
  }
  return p;
}

export async function wipe() {
  await withApi((api) => api.wipe());
}
