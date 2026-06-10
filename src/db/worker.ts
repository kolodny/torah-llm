/// <reference lib="webworker" />
//
// The dedicated worker that owns SQLite-WASM + the OPFS SAH-pool VFS. It is spawned by the
// *leader tab* (a window context, where `Worker` exists — a SharedWorker can't spawn it) and
// shared by every tab via per-tab MessagePorts brokered through the SharedWorker. So one
// connection backs all tabs: no exclusive-handle conflicts, and downloaded books are shared.
//
// It self-boots: downloads the TOC DB if absent, opens it, and re-downloads on a version bump.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { expose } from 'comlink';
import type { Progress } from './types';
import { BOOT_VERSION } from '../../shared/schema';
import { TOC_DB } from '../../shared/slice-path';

(self as unknown as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = {
  warn: (...args: unknown[]) => {
    if (!String(args[0]).includes('Ignoring inability to install OPFS')) console.warn(...args);
  },
};

const BOOT_PATH = '/db.sqlite';
const bootUrl = `${import.meta.env.BASE_URL}db/${TOC_DB}`;

const init = (async () => {
  const sqlite3 = await sqlite3InitModule({ print: console.log, printErr: console.error });
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'torah-llm' });
  // Default pool holds ~1-2 DBs; merge needs the boot DB + a slice + temp slots simultaneously.
  await pool.reserveMinimumCapacity(8);
  return { sqlite3, pool };
})();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function streamInto(pool: any, path: string, url: string, onProgress?: (p: Progress) => void) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body!.getReader();
  let received = 0;
  await pool.importDb(path, async () => {
    const { done, value } = await reader.read();
    if (done || !value) return undefined;
    received += value.length;
    onProgress?.({ received, total });
    return value;
  });
}

// Ensure the boot DB is present, current, and open. Retryable: a failed boot (offline / transient
// fetch error) re-arms so the next call tries again instead of poisoning the worker permanently.
let bootP: Promise<void> | null = null;
function boot(): Promise<void> {
  if (!bootP)
    bootP = doBoot().catch((e) => {
      bootP = null;
      throw e;
    });
  return bootP;
}
async function doBoot() {
  const { pool } = await init;
  const openBoot = () => {
    db = new pool.OpfsSAHPoolDb(BOOT_PATH);
  };
  if (!pool.getFileNames().includes(BOOT_PATH)) {
    await streamInto(pool, BOOT_PATH, bootUrl);
    openBoot();
    return;
  }
  openBoot();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  db.exec({ sql: 'PRAGMA user_version', rowMode: 'object', resultRows: rows });
  if ((rows[0]?.user_version ?? 0) !== BOOT_VERSION) {
    db.close();
    db = undefined;
    await pool.wipeFiles();
    await streamInto(pool, BOOT_PATH, bootUrl);
    openBoot();
  }
}

const api = {
  async version() {
    const { sqlite3 } = await init;
    return sqlite3.version.libVersion;
  },

  /** Run SQL; returns rows as objects (empty for non-SELECT). */
  async exec(sql: string, params: unknown[] = []) {
    await boot();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultRows: any[] = [];
    db.exec({ sql, bind: params.length ? params : undefined, rowMode: 'object', resultRows });
    return resultRows;
  },

  /** Download a book slice (if not already present) and merge its rows into the open DB. */
  async merge(url: string, path: string, onProgress?: (p: Progress) => void) {
    const { pool } = await init;
    await boot();
    if (!pool.getFileNames().includes(path)) await streamInto(pool, path, url, onProgress);
    db.exec(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS merge`); // escape ' (book ids like "Ba'al HaTurim")
    try {
      db.exec(`INSERT OR IGNORE INTO editions (id,toc_id,source,lang,title,info,order_index) SELECT id,toc_id,source,lang,title,info,order_index FROM merge.editions`);
      db.exec(`INSERT OR IGNORE INTO content (id,edition_id,toc_id,ref,text) SELECT id,edition_id,toc_id,ref,text FROM merge.content`);
      db.exec(`INSERT OR IGNORE INTO meta (toc_id,schema) SELECT toc_id,schema FROM merge.meta`);
      db.exec(`INSERT OR IGNORE INTO links (id,from_id,from_ref,to_id,to_ref,connection_type) SELECT id,from_id,from_ref,to_id,to_ref,connection_type FROM merge.links`);
    } finally {
      db.exec(`DETACH DATABASE merge`);
    }
    pool.unlink(path);
  },

  async wipe() {
    const { pool } = await init;
    if (db) {
      db.close();
      db = undefined;
    }
    await pool.wipeFiles();
  },
};

// The leader tab forwards one MessagePort per connecting tab; expose the API on each.
self.onmessage = (event: MessageEvent) => {
  if (event.data?.type === 'connect' && event.data.port) {
    const port = event.data.port as MessagePort;
    expose(api, port);
    port.start();
  }
};

export type Api = typeof api;
