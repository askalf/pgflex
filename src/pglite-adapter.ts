/**
 * PGliteAdapter — runs PostgreSQL in-process via WASM
 * ([@electric-sql/pglite](https://pglite.dev)). The "standalone" mode:
 * no external server, no Docker, no port to bind. State lives on disk
 * at `dataDir`; pass `memory://` for ephemeral.
 *
 * PGlite speaks full PostgreSQL dialect, so the same SQL works in pg
 * mode and pglite mode — the whole point of the dual-adapter shape.
 *
 * `@electric-sql/pglite` is an `optionalDependencies` so `pg`-only users
 * can skip the WASM bytes (`--omit=optional`). If you actually use
 * pglite mode and the package isn't installed, `init()` throws a clear
 * error.
 *
 * Extensions are opt-in — pass `{ extensions: ['vector'] }` to load
 * pgvector at init. PGlite 0.5 moved pgvector out of the core package
 * into `@electric-sql/pglite-pgvector` (also in our
 * `optionalDependencies`); the loader below tries the new package
 * first and falls back to the pre-0.5 `@electric-sql/pglite/vector`
 * subpath, so both layouts work. Other PGlite contrib extensions
 * (uuid-ossp, pgcrypto, etc.) need their own JS-side import to register
 * the WASM hooks, so listing them here will currently run
 * `CREATE EXTENSION IF NOT EXISTS <name>` but won't expose the
 * extension's functions. Open an issue if you need one wired up.
 */

import type {
  DatabaseAdapter,
  NotificationHandler,
  QueryResultRow,
  TransactionClient,
} from './interface.js';

export interface PGliteAdapterOptions {
  /** Filesystem path for persistent storage, or `memory://` for an
   *  ephemeral in-WASM database. */
  dataDir: string;
  /** PGlite extensions to enable at init. Currently only `'vector'`
   *  (pgvector) is wired with both JS-side and SQL-side hooks. Other
   *  names will run `CREATE EXTENSION IF NOT EXISTS <name>` only —
   *  enough if PGlite already has the extension built into its WASM
   *  but not enough for contrib extensions that need a JS shim
   *  (uuid-ossp, pgcrypto, etc.). Default: none. */
  extensions?: ReadonlyArray<string>;
  /** When true, log a single line on init showing the data directory.
   *  Default false (libraries shouldn't be chatty). */
  verbose?: boolean;
}

// Minimal structural types for the PGlite instance — we only touch
// these members. Avoids depending on `@electric-sql/pglite`'s types,
// which would force the dep up to `dependencies` (defeating the
// point of `optionalDependencies`).
interface PGliteTransaction {
  query(text: string, params?: unknown[]): Promise<{ rows?: unknown[] }>;
  exec(sql: string): Promise<unknown>;
}
interface PGliteInstance {
  query(text: string, params?: unknown[]): Promise<{ rows?: unknown[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(cb: (tx: PGliteTransaction) => Promise<T>): Promise<T>;
  listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
  waitReady: Promise<void>;
}
interface PGliteCtor {
  new (opts: { dataDir: string; extensions: Record<string, unknown> }): PGliteInstance;
}

// Cached across all adapter instances — PGlite is a single shared WASM
// module, no benefit to re-importing per-instance.
let PGliteCtor: PGliteCtor | undefined;
let pgVectorExt: unknown;

async function ensurePGliteLoaded(): Promise<PGliteCtor> {
  if (PGliteCtor) return PGliteCtor;
  try {
    const mod = await import('@electric-sql/pglite');
    PGliteCtor = (mod as { PGlite: PGliteCtor }).PGlite;
    return PGliteCtor;
  } catch {
    throw new Error(
      '@electric-sql/pglite is required for pglite mode. Install it with: npm install @electric-sql/pglite',
    );
  }
}

// PGlite >= 0.5 ships pgvector as a standalone package; <= 0.4 had it
// as a subpath of the core package. Try both, newest first. The
// specifiers live in a variable so tsc doesn't try to statically
// resolve a subpath that no longer exists in the installed version's
// exports map.
const VECTOR_MODULE_CANDIDATES: ReadonlyArray<string> = [
  '@electric-sql/pglite-pgvector',
  '@electric-sql/pglite/vector',
];

async function loadPgVectorExtension(): Promise<unknown> {
  if (pgVectorExt) return pgVectorExt;
  for (const specifier of VECTOR_MODULE_CANDIDATES) {
    try {
      const mod = (await import(specifier)) as { vector?: unknown };
      if (mod.vector) {
        pgVectorExt = mod.vector;
        return pgVectorExt;
      }
    } catch {
      // Not installed under this layout — try the next candidate.
    }
  }
  throw new Error(
    'Failed to load pgvector. On PGlite >= 0.5 install it with: npm install @electric-sql/pglite-pgvector ' +
      '(older PGlite versions bundled it as @electric-sql/pglite/vector).',
  );
}

export class PGliteAdapter implements DatabaseAdapter {
  readonly mode = 'pglite' as const;
  private db: PGliteInstance | null = null;
  private readonly dataDir: string;
  private readonly extensions: ReadonlyArray<string>;
  private readonly verbose: boolean;

  constructor(opts: PGliteAdapterOptions) {
    this.dataDir = opts.dataDir;
    this.extensions = opts.extensions ?? [];
    this.verbose = opts.verbose ?? false;
  }

  async init(): Promise<void> {
    const Ctor = await ensurePGliteLoaded();

    const pgliteExtensions: Record<string, unknown> = {};
    for (const ext of this.extensions) {
      if (ext === 'vector') {
        pgliteExtensions['vector'] = await loadPgVectorExtension();
      }
      // Other extensions are SQL-loadable below — no JS-side wiring needed.
    }

    this.db = new Ctor({
      dataDir: this.dataDir,
      extensions: pgliteExtensions,
    });

    await this.db.waitReady;

    for (const ext of this.extensions) {
      // SQL extensions get a CREATE EXTENSION IF NOT EXISTS — idempotent,
      // safe to re-run on every init. Quote ext names that contain dashes
      // (PostgreSQL syntax requires it for `uuid-ossp`).
      const quoted = /[^a-z0-9_]/i.test(ext) ? `"${ext}"` : ext;
      await this.db?.query(`CREATE EXTENSION IF NOT EXISTS ${quoted}`).catch((err: Error) => {
        process.stderr.write(`[pgflex/pglite] CREATE EXTENSION ${ext} failed: ${err.message}\n`);
      });
    }

    if (this.verbose) {
      process.stderr.write(`[pgflex/pglite] initialized at ${this.dataDir}\n`);
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]> {
    if (!this.db) throw new Error('PGliteAdapter not initialized; call init() first');
    const result = await this.db.query(text, params);
    return (result.rows ?? []) as T[];
  }

  async queryOne<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    if (!this.db) throw new Error('PGliteAdapter not initialized; call init() first');
    await this.db.exec(sql);
  }

  async transaction<T>(
    fn: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!this.db) throw new Error('PGliteAdapter not initialized; call init() first');

    // Delegate to PGlite's native transaction(), which holds an
    // exclusive lock for the duration — concurrent transaction() calls
    // queue instead of interleaving BEGIN/COMMIT on the single shared
    // connection, and standalone query() calls wait too. (Pre-0.1.0
    // this was a hand-rolled BEGIN/COMMIT with neither guarantee.)
    return this.db.transaction(async (tx) => {
      const client: TransactionClient = {
        query: async <R extends QueryResultRow = QueryResultRow>(
          text: string,
          params?: unknown[],
        ) => {
          const result = await tx.query(text, params);
          return { rows: (result.rows ?? []) as R[] };
        },
        exec: async (sql: string) => {
          await tx.exec(sql);
        },
      };
      return fn(client);
    });
  }

  // ── LISTEN/NOTIFY ──

  async listen(
    channel: string,
    handler: NotificationHandler,
  ): Promise<() => Promise<void>> {
    if (!this.db) throw new Error('PGliteAdapter not initialized; call init() first');
    const unsubscribe = await this.db.listen(channel, handler);
    return async () => {
      await unsubscribe();
    };
  }

  async notify(channel: string, payload?: string): Promise<void> {
    await this.query('SELECT pg_notify($1, $2)', [channel, payload ?? '']);
  }

  async ping(): Promise<boolean> {
    if (!this.db) return false;
    try {
      await this.db.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}
