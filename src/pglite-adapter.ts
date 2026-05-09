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
 * don't pay for the WASM bytes. If you actually use pglite mode and the
 * package isn't installed, `init()` throws a clear error.
 *
 * Extensions are opt-in — pass `{ extensions: ['vector'] }` to load
 * pgvector at init. v0.0.1 wires `vector` end-to-end; other PGlite
 * contrib extensions (uuid-ossp, pgcrypto, etc.) need their own JS-side
 * import to register the WASM hooks, so listing them here will currently
 * run `CREATE EXTENSION IF NOT EXISTS <name>` but won't expose the
 * extension's functions. Open an issue if you need one wired up.
 */

import type { DatabaseAdapter, QueryResultRow, TransactionClient } from './interface.js';

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

// Minimal structural type for the PGlite instance — we only use these
// three members. Avoids depending on `@electric-sql/pglite`'s types,
// which would force the dep up to `dependencies` (defeating the
// point of `optionalDependencies`).
interface PGliteInstance {
  query(text: string, params?: unknown[]): Promise<{ rows?: unknown[] }>;
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

async function loadPgVectorExtension(): Promise<unknown> {
  if (pgVectorExt) return pgVectorExt;
  try {
    const mod = await import('@electric-sql/pglite/vector');
    pgVectorExt = (mod as { vector: unknown }).vector;
    return pgVectorExt;
  } catch {
    throw new Error(
      'Failed to load pgvector extension. Your installed version of @electric-sql/pglite may not include it.',
    );
  }
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

  async transaction<T>(
    fn: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!this.db) throw new Error('PGliteAdapter not initialized; call init() first');

    // PGlite is single-process, single-connection — there's no separate
    // "client" to check out. We satisfy the TransactionClient shape with
    // a thin wrapper around the same db.
    const db = this.db;
    const client: TransactionClient = {
      query: async <R extends QueryResultRow = QueryResultRow>(
        text: string,
        params?: unknown[],
      ) => {
        const result = await db.query(text, params);
        return { rows: (result.rows ?? []) as R[] };
      },
    };

    await this.db.query('BEGIN');
    try {
      const result = await fn(client);
      await this.db.query('COMMIT');
      return result;
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}
